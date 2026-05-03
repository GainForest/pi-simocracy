/**
 * AnimatedImage — a pi-tui `Component` that cycles through PNG frames in
 * place using the Kitty graphics protocol's image-by-ID swap.
 *
 * Why not just reuse pi-tui's `Image`?
 *
 * `Image` caches its render output and `Image.base64Data` is declared
 * `private`, so we can't mutate the source bytes between renders to
 * swap frames. Pi-tui's own animated component (`Loader`, the spinner)
 * works because it extends `Text` and calls `setText()` to swap its
 * payload — there's no equivalent setter on `Image`. Rather than reach
 * into pi-tui internals or upstream a patch, we ship a tiny standalone
 * `Component` that owns its frames + timer and emits the appropriate
 * Kitty / iTerm2 escape on every `render()` call.
 *
 * Behaviour:
 *
 *  - `render(width)` always emits the *current* frame's escape sequence
 *    (no across-frame cache). Same line-shape trick as pi-tui's `Image`:
 *    return `rows` lines, the last carrying the cursor-up + image
 *    transmission so the bitmap occupies all `rows` of vertical space.
 *  - The `setInterval` ticks `currentFrame` and calls
 *    `tui.requestRender()` — pi-tui re-runs the diff renderer, our
 *    `render()` produces a new escape, the terminal swaps the bitmap
 *    in place by image ID. Same pattern pi-tui's spinner uses for the
 *    text spinner; typing keeps working because input handling is on
 *    an independent code path.
 *  - The interval is `unref()`ed so it doesn't keep the node process
 *    alive on shutdown.
 *  - `dispose()` clears the interval. Call it when the sim unloads or
 *    when a new sim takes over the active-animation slot.
 *  - In terminals without `kitty` / `iterm2` capability the component
 *    emits a single line of fallback text instead — but in practice
 *    the message renderer never instantiates `AnimatedImage` on those
 *    terminals; it returns the ANSI half-block `Text` path.
 */

import {
  type Component,
  type ImageDimensions,
  type TUI,
  encodeKitty,
  encodeITerm2,
  getCapabilities,
  calculateImageRows,
  getCellDimensions,
} from "@mariozechner/pi-tui";

export interface AnimatedImageOptions {
  /** Pre-encoded base64 PNG bytes per frame, in playback order.
   *  At least 2 frames; otherwise just use a static `Image` instead. */
  frames: string[];
  /** Native frame dimensions in pixels — used both for aspect ratio
   *  during display-cell calculation and for the `c=,r=` parameters
   *  on the Kitty escape. Uniform across all frames. */
  dimensions: ImageDimensions;
  /** Display target in terminal cells. Aspect-preserved height is
   *  computed from `dimensions`. */
  maxWidthCells: number;
  /** Stable Kitty image ID — every frame transmission carries this so
   *  the terminal swaps the bitmap in place rather than stacking
   *  copies. Allocate once per AnimatedImage with `allocateImageId()`. */
  imageId: number;
  /** Display rate. Internally clamped to ≤ 16 fps to keep escape
   *  bandwidth reasonable. */
  fps: number;
  /** TUI handle. Required so we can call `requestRender()` after each
   *  frame tick. `setWidget`'s factory form is the canonical way to
   *  obtain this from inside an extension. */
  tui: TUI;
  /** Fallback text printed when `getCapabilities().images` is null
   *  (e.g. user forced ANSI mid-render). Defaults to "[animation]". */
  fallbackText?: string;
}

export class AnimatedImage implements Component {
  private readonly frames: string[];
  private readonly dimensions: ImageDimensions;
  private readonly maxWidthCells: number;
  private readonly imageId: number;
  private readonly tui: TUI;
  private readonly fallbackText: string;

  /** Index into `frames`. Mutates on each tick. */
  private currentFrame = 0;
  /** Active animation timer, or null when stopped / disposed. */
  private intervalId: ReturnType<typeof setInterval> | null = null;
  /** True after `dispose()` — render() then short-circuits to a single
   *  empty line so the diff renderer cleanly removes the image. */
  private disposed = false;

  constructor(opts: AnimatedImageOptions) {
    if (opts.frames.length < 2) {
      throw new Error(
        `AnimatedImage requires at least 2 frames (got ${opts.frames.length}); use pi-tui's Image for a single frame.`,
      );
    }
    this.frames = opts.frames;
    this.dimensions = opts.dimensions;
    this.maxWidthCells = opts.maxWidthCells;
    this.imageId = opts.imageId;
    this.tui = opts.tui;
    this.fallbackText = opts.fallbackText ?? "[animation]";

    // Clamp fps to ≤ 16 — each tick re-transmits the full PNG, ~30–50
    // KB per codex pet frame. 16 fps = ~800 KB/s, plenty of headroom.
    const fps = Math.min(Math.max(opts.fps, 1), 16);
    const intervalMs = Math.round(1000 / fps);
    this.intervalId = setInterval(() => {
      if (this.disposed) return;
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      // Pi-tui's render tick will call our `render()` again, which
      // emits the new frame's escape sequence. The terminal swaps the
      // bitmap in place by image ID — no flicker, no scrollback churn.
      this.tui.requestRender();
    }, intervalMs);
    // Don't keep the node process alive solely for the animation
    // timer — let SIGINT and process exit work cleanly.
    this.intervalId.unref?.();
  }

  /** Stop the timer. Idempotent. After dispose, `render()` returns an
   *  empty single line so pi-tui's diff renderer cleanly clears the
   *  cells the animation was occupying. */
  dispose(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.disposed = true;
  }

  /**
   * Emit the current frame as a Kitty / iTerm2 inline image escape.
   * Same line-shape contract pi-tui's `Image` uses: `rows` lines, the
   * last one containing `\x1b[<rows-1>A` followed by the actual image
   * transmission. The first `rows-1` lines are empty; pi-tui's diff
   * renderer treats them as occupied vertical space.
   */
  render(width: number): string[] {
    if (this.disposed) return [""];
    const caps = getCapabilities();
    if (!caps.images) {
      // Should never happen in practice — the message renderer only
      // builds an AnimatedImage when caps.images is truthy. Soft
      // fallback so the layout doesn't collapse if caps change at
      // runtime (e.g. user resizes into iTerm2 from Kitty mid-session).
      return [this.fallbackText];
    }
    const maxWidth = Math.min(width - 2, this.maxWidthCells);
    const rows = calculateImageRows(this.dimensions, maxWidth, getCellDimensions());
    const base64 = this.frames[this.currentFrame] ?? this.frames[0];

    let sequence: string;
    if (caps.images === "kitty") {
      // imageId is required for in-place swap — that's the whole point
      // of AnimatedImage. encodeKitty handles the chunked transmission
      // for payloads above the protocol's 4096-byte chunk limit.
      sequence = encodeKitty(base64, {
        columns: maxWidth,
        rows,
        imageId: this.imageId,
      });
    } else {
      // iTerm2: no image-ID swap, but it draws the new image at the
      // current cursor; combined with the cursor-up trick below, the
      // visual effect is "in place" enough for our needs.
      sequence = encodeITerm2(base64, {
        width: maxWidth,
        height: "auto",
        preserveAspectRatio: true,
      });
    }

    const lines: string[] = [];
    for (let i = 0; i < rows - 1; i++) lines.push("");
    const moveUp = rows > 1 ? `\x1b[${rows - 1}A` : "";
    lines.push(moveUp + sequence);
    return lines;
  }

  /** No internal cache to clear — `render()` always recomputes from
   *  `currentFrame`. Provided for `Component` interface conformance and
   *  in case pi-tui ever calls invalidate() on the parent tree. */
  invalidate(): void {
    /* intentionally empty */
  }
}
