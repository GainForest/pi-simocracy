/**
 * pi-simocracy — load a Simocracy sim into your pi chat, refine its
 * constitution + speaking style by chatting with pi, and write the
 * result back to your ATProto PDS.
 *
 * Sim commands:
 *  - `/sim <name>`        Load a sim by name (fuzzy search on the indexer).
 *                         Renders the sprite inline as colored ANSI art and
 *                         pushes the sim's constitution + style into the
 *                         system prompt so pi roleplays as the sim.
 *  - `/sim unload`        Drop the loaded sim and stop roleplaying.
 *  - `/sim status`        Show the currently loaded sim, if any.
 *
 * Editing your sim's constitution / speaking style:
 *  There is no `/sim train` or `/sim interview` slash flow. Instead,
 *  load a sim you own and tell pi how you want the persona to change
 *  ("add a red line about animal welfare", "make the speaking style
 *  punchier and drop the lenny faces", etc.). Pi rewrites the
 *  constitution and/or speaking style and calls the
 *  `simocracy_update_sim` tool to write the result to your PDS.
 *  Requires `/sim login` and ownership of the loaded sim.
 *
 * ATProto sign-in ("sign in with Bluesky / ATProto", NOT Anthropic):
 *  - `/sim login [handle]`
 *        Loopback OAuth flow — opens your PDS's authorize page in the
 *        browser, grants this CLI a DPoP-bound session, persists it to
 *        ~/.config/pi-simocracy/auth.json. Required before pi can
 *        update your sim's constitution / style.
 *  - `/sim logout`        Clear the local OAuth session.
 *  - `/sim whoami`        Show the currently signed-in ATProto handle/DID.
 *
 * Browse your own sims (requires `/sim login`):
 *  - `/sim my`            Pick from the org.simocracy.sim records owned
 *                         by the signed-in DID. Single sim auto-loads;
 *                         multiple sims open a picker, and the chosen one
 *                         renders inline exactly like `/sim <name>`.
 *  - `/sim my <name>`     Fuzzy-load by name within your own sims.
 *                         Exact match auto-loads; ambiguous matches
 *                         open the same picker.
 *
 * Tools (LLM-callable):
 *  - `simocracy_load_sim`     Same as /sim <name>.
 *  - `simocracy_unload_sim`   Same as /sim unload.
 *  - `simocracy_chat`         One-shot chat with a sim via OpenRouter
 *                             (does not change the active session
 *                             persona).
 *  - `simocracy_update_sim`   Write a new constitution and/or speaking
 *                             style for the loaded sim to the user's
 *                             PDS. Requires the user to be signed in
 *                             via /sim login AND to own the sim.
 *  - `simocracy_post_comment` Write a comment on a proposal /
 *                             gathering / sim / decision / parent
 *                             comment, attributed to the loaded sim
 *                             via an `org.simocracy.history` sidecar
 *                             (no impactindexer lexicon changes).
 *                             Requires /sim login + ownership.
 *  - `simocracy_post_proposal` Submit a new funding proposal
 *                             (`org.hypercerts.claim.activity`) on
 *                             behalf of the loaded sim, plus an
 *                             `org.simocracy.history` sidecar with
 *                             `type: "proposal"`. Same write pattern
 *                             as `simocracy_post_comment`. Requires
 *                             /sim login + sim ownership.
 *  - `simocracy_lookup_record` Look up a sim / proposal / gathering /
 *                             decision / comment by AT-URI or fuzzy
 *                             name and return its details + comment
 *                             subtree with sim attribution joined.
 *
 * Note on /login: pi itself ships a built-in `/login` for Anthropic OAuth.
 * To avoid the collision (and to make it explicit you're signing into
 * ATProto, not Anthropic), all auth commands here are namespaced under
 * `/sim`.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import {
  Box,
  Image,
  Text,
  allocateImageId,
  getCapabilities,
  type ImageTheme,
  type TUI,
} from "@mariozechner/pi-tui";
import { AnimatedImage } from "./animated-image.ts";
import { Type } from "typebox";

import {
  searchSimsByName,
  fetchSimsForDid,
  fetchAgentsForSim,
  fetchStyleForSim,
  fetchBlob,
  fetchSkillMd,
  resolveHandle,
  parseAtUri,
  type AgentsRecord,
  type SimMatch,
  type StyleRecord,
} from "./simocracy.ts";
import {
  bestNameForRecord,
  lookupRecord,
  type LookupKind,
  type LookupResult,
  type ResolvedComment,
} from "./lookup.ts";
import {
  decodePng,
  renderRgbaToAnsi,
  cropRgba,
  detectPixelArtScale,
  downscaleRgbaNearest,
  boxDownscaleRgba,
} from "./png-to-ansi.ts";
import { encodeRgbaToPng } from "./png-encode.ts";
import { decodeWebp } from "./webp-to-rgba.ts";
import { openRouterComplete, type ChatMessage } from "./openrouter.ts";
import { buildSimPrompt, type LoadedSim } from "./persona.ts";
import { runLogin, runLogout, runWhoami } from "./auth/commands.ts";
import { readAuth } from "./auth/storage.ts";
import {
  assertCanWriteToSim,
  createAgents,
  createComment,
  createCommentHistory,
  createProposal,
  createProposalHistory,
  createStyle,
  findRkeyForSim,
  getAuthenticatedAgent,
  NotSignedInError,
  NotSimOwnerError,
  updateAgents,
  updateStyle,
} from "./writes.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let loadedSim: LoadedSim | null = null;
/**
 * Name of the most recently unloaded sim, if any. Cleared after the next
 * agent turn fires — used to inject a one-shot “stop roleplaying” override
 * into the system prompt so the model breaks character even though its
 * previous in-character replies are still in the conversation history.
 */
let justUnloaded: string | null = null;

// ---------------------------------------------------------------------------
// Animation state
//
// We animate the most recently loaded codex pet's idle row inline in chat,
// using the same pattern pi-tui's spinner uses: a setInterval ticks a frame
// counter and calls `tui.requestRender()`, which makes pi-tui re-run the
// message renderer. Each render returns a new `Image` keyed by a stable
// Kitty image ID, so the terminal swaps the displayed frame in place.
//
// Typing keeps working during animation — input handling and rendering are
// independent code paths in pi-tui (verified by inspection of `Loader`).
//
// Only ONE sim animates at a time. When a new sim is loaded, the previous
// timer stops and the previous message freezes on its idle frame.
// ---------------------------------------------------------------------------

/** Captured pi-tui handle. Set by the `simocracy` widget factory the first
 *  time a sim is loaded; reused for every subsequent animation tick. Lazy
 *  because the TUI doesn't exist when the extension first imports. */
let capturedTui: TUI | null = null;

interface ActiveAnimation {
  /** Identifies which loaded-sim message owns this animation. The
   *  renderer compares against `details.animationKey` to decide
   *  whether to mount the live `AnimatedImage` for this message or a
   *  static idle frame. */
  key: string;
  /** Stable Kitty image ID so frame transmissions replace the previous one
   *  instead of stacking. Allocated once per sim load. */
  imageId: number;
  /** Pre-encoded base64 PNGs in playback order. */
  frames: string[];
  /** Frame width / height in pixels (uniform across frames). */
  widthPx: number;
  heightPx: number;
  /** Display rate. */
  fps: number;
  /**
   * The live animated component. Created lazily inside the message
   * renderer the first time it's asked for this `key` — we need a
   * TUI handle to construct one, and the renderer is the natural
   * place that has access (via `capturedTui`). Disposed when a new
   * sim takes over the active-animation slot or when the sim is
   * unloaded.
   */
  component: AnimatedImage | null;
}
let currentAnimation: ActiveAnimation | null = null;

/** Default-on; set `SIMOCRACY_ANIMATION=off` to freeze on idle frame 0. */
const animationEnabled =
  (process.env.SIMOCRACY_ANIMATION ?? "on").toLowerCase() !== "off";

/**
 * Width of the inline sprite render in terminal cells. The source PNG
 * is always transmitted at native resolution (192×208 for codex pets,
 * 32×32 for pipoya — see `renderSprite`); this number controls only
 * how many cells the terminal uses to display it. Aspect ratio is
 * preserved by pi-tui's `calculateImageRows`. Override with the
 * `SIMOCRACY_SPRITE_WIDTH` env var.
 *
 * 10 cells wide gives a compact ≈6-row inline render that sits
 * comfortably alongside one or two paragraphs of bio text without
 * dominating the chat. Bump it to 20 or 32 if you want the sprite
 * to read at a glance.
 */
const spriteWidthCells = (() => {
  const raw = process.env.SIMOCRACY_SPRITE_WIDTH;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 4 && parsed <= 120 ? parsed : 10;
})();

function stopCurrentAnimation(): void {
  if (currentAnimation?.component) {
    currentAnimation.component.dispose();
  }
  currentAnimation = null;
}

function startAnimationFor(
  key: string,
  frames: { pngBase64: string[]; fps: number; widthPx: number; heightPx: number },
): void {
  // Always replace any prior animation — only the most recent
  // loaded-sim message animates.
  stopCurrentAnimation();
  if (!animationEnabled || frames.pngBase64.length < 2) return;
  currentAnimation = {
    key,
    imageId: allocateImageId(),
    frames: frames.pngBase64,
    widthPx: frames.widthPx,
    heightPx: frames.heightPx,
    fps: frames.fps,
    // Lazily instantiated by the message renderer the first time it
    // sees this `key` — we don't have a TUI handle here, only inside
    // the setWidget factory.
    component: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blobLink(ref: unknown): string | null {
  if (ref && typeof ref === "object" && "$link" in (ref as Record<string, unknown>)) {
    const l = (ref as { $link?: unknown }).$link;
    if (typeof l === "string") return l;
  }
  return null;
}

/**
 * Maximum long-edge of a non-pixel-art avatar before we box-downscale it.
 * Picked so codex pet idle frames render at roughly the same on-screen
 * height as a 32×32 pipoya sprite (~17 terminal lines) instead of
 * ballooning to 60+ lines and pushing the rest of chat off-screen.
 */
const NON_PIXEL_ART_TARGET_LONG_EDGE = 40;

/**
 * Render a sim's avatar as colored ANSI half-block art, sized to fit
 * comfortably alongside the loaded-sim message in a typical terminal.
 *
 * Branches on `spriteKind` (lexicon discriminator):
 *
 *   pipoya   — fetch the 4×4 walk-sheet PNG, crop the front-facing
 *              walk-1 frame (32×32, row 0 col 0), render at native
 *              resolution. ~16 lines tall.
 *
 *   codexPet — prefer the 8×9 atlas (`petSheet`, 1536×1872, 192×208
 *              cells) when it's PNG: crop the idle cell (row 0 col 0)
 *              and box-downscale to ~32 wide. The atlas is usually WebP
 *              (the OpenAI hatch-pet skill emits WebP and `pngjs`
 *              doesn't speak WebP), so we fall through to the rendered
 *              `image` thumbnail — a PNG that the simocracy.org client
 *              generates at 128×128 from the idle frame. That gets
 *              box-downscaled to a comparable terminal size.
 *
 *   absent   — treated as legacy 'pipoya' for back-compat.
 *
 * Returns BOTH the ANSI half-block render (always — it's our universal
 * fallback) AND, when possible, a PNG of the same RGBA cell for inline
 * terminal-graphics protocols (Kitty / iTerm2). The renderer chooses
 * which to display based on the host terminal's capabilities.
 *
 * The PNG is encoded at the *native* resolution we cropped to (32×32
 * for pipoya, 192×208 for codexPet, the post-downscale size for the
 * image fallback). Kitty / iTerm2 do their own scaling to the target
 * cell box, so passing the native pixels gives the terminal the most
 * information to work with — pixel art scales up crisply with
 * nearest-neighbour, codex pet thumbnails scale down cleanly.
 */
export interface SpriteRender {
  ansi: string;
  png?: { data: Buffer; widthPx: number; heightPx: number };
  /**
   * Optional animation frames. Each entry in `pngs` is a PNG of one
   * cell. Set for codex pets (idle row of their atlas); absent for
   * everything else (pipoya sprites and image fallbacks render as a
   * single static frame). The renderer plays these in a loop using
   * the Kitty in-place image-swap protocol when animation is enabled.
   */
  frames?: { pngs: Buffer[]; widthPx: number; heightPx: number; fps: number };
}

/**
 * Codex pet atlas constants — keep in sync with the simocracy-v2 hatch-pet
 * skill that produces these sheets. The atlas is 8 cols × 9 rows of
 * 192×208 cells; the idle animation lives on row 0, frames 0–5 (the same
 * default tui-pets ships when a pet.json doesn't override it).
 */
const CODEX_PET_CELL_W = 192;
const CODEX_PET_CELL_H = 208;
const CODEX_PET_COLS = 8;
const CODEX_PET_IDLE_FRAMES = [0, 1, 2, 3, 4, 5];
const CODEX_PET_IDLE_FPS = 5;

async function renderSprite(sim: SimMatch): Promise<SpriteRender | null> {
  const spriteKind = sim.sim.spriteKind ?? "pipoya";
  const spriteLink = blobLink(sim.sim.sprite?.ref);
  const petSheetLink = blobLink(sim.sim.petSheet?.ref);
  const petSheetMime = sim.sim.petSheet?.mimeType;
  const imageLink = blobLink(sim.sim.image?.ref);

  /** Render an RGBA region to ANSI half-blocks (shared options). */
  const toAnsi = (data: Buffer, width: number, height: number) =>
    renderRgbaToAnsi(data, width, height, {
      cropToContent: true,
      cropPad: 1,
      indent: 2,
      alphaThreshold: 16,
    });

  /** Bundle ANSI + PNG of the same RGBA region. PNG-encode is a tiny
   *  cost and is wrapped in try/catch — if encoding ever fails we
   *  still return the ANSI render (lossless fallback). */
  const bundle = (data: Buffer, width: number, height: number): SpriteRender => {
    const ansi = toAnsi(data, width, height);
    let png: SpriteRender["png"];
    try {
      const pngBytes = encodeRgbaToPng(data, width, height);
      png = { data: pngBytes, widthPx: width, heightPx: height };
    } catch {
      png = undefined;
    }
    return { ansi, png };
  };

  // Pipoya 4×4 walk sheet — the legacy/default path.
  if (spriteKind !== "codexPet" && spriteLink) {
    try {
      const buf = await fetchBlob(sim.did, spriteLink);
      const { width, height, data } = decodePng(buf);
      const FRAME = 32;
      if (width >= FRAME && height >= FRAME) {
        // Sheets are 4×4 of 32×32 frames — row 0 col 0 = front-facing walk1.
        const frame = cropRgba(data, width, height, 0, 0, FRAME, FRAME);
        return bundle(frame, FRAME, FRAME);
      }
      return bundle(data, width, height);
    } catch {
      /* fall through to image fallback */
    }
  }

  // Codex pet atlas — the canonical asset for codex pets. Sheets are
  // 1536×1872 with 192×208 cells laid out 8 cols × 9 rows; row 0 col 0
  // is the idle frame. Both PNG and WebP are valid in the lexicon (the
  // hatch-pet skill emits WebP, the dropzone preserves PNG when the
  // user drops a PNG sheet) so we pick the right decoder by mimeType.
  // We crop the idle cell first thing. For the ANSI render we
  // box-downscale to ~32 wide so the inline render is similar in
  // height to a pipoya sprite (~17 lines). For the inline-graphics
  // PNG we keep the native 192×208 resolution — Kitty / iTerm2 will
  // scale it down at display time, which preserves more detail than
  // pre-downscaling here.
  if (spriteKind === "codexPet" && petSheetLink) {
    try {
      const buf = await fetchBlob(sim.did, petSheetLink);
      const { width, height, data } =
        petSheetMime === "image/webp" ? await decodeWebp(buf) : decodePng(buf);
      const CELL_W = 192;
      const CELL_H = 208;
      if (width >= CELL_W && height >= CELL_H) {
        const cell = cropRgba(data, width, height, 0, 0, CELL_W, CELL_H);
        const targetW = 32;
        const targetH = Math.round((CELL_H / CELL_W) * targetW); // ~35
        const scaled = boxDownscaleRgba(cell, CELL_W, CELL_H, targetW, targetH);
        const ansi = toAnsi(scaled.data, scaled.width, scaled.height);
        let png: SpriteRender["png"];
        try {
          const pngBytes = encodeRgbaToPng(cell, CELL_W, CELL_H);
          png = { data: pngBytes, widthPx: CELL_W, heightPx: CELL_H };
        } catch {
          png = undefined;
        }

        // Idle animation frames — same atlas, different cell offsets.
        // Encoded eagerly here so the message renderer can flip
        // between them at ~5 FPS without re-decoding the WebP. Wrapped
        // in its own try/catch — a frame-encoding failure shouldn't
        // disable the static render.
        let frames: SpriteRender["frames"];
        try {
          const framePngs: Buffer[] = [];
          for (const idx of CODEX_PET_IDLE_FRAMES) {
            const cx = (idx % CODEX_PET_COLS) * CELL_W;
            const cy = Math.floor(idx / CODEX_PET_COLS) * CELL_H;
            // Skip frames that fall outside the actual atlas extent.
            if (cx + CELL_W > width || cy + CELL_H > height) continue;
            const frameCell = cropRgba(data, width, height, cx, cy, CELL_W, CELL_H);
            framePngs.push(encodeRgbaToPng(frameCell, CELL_W, CELL_H));
          }
          // Single-frame "animations" are pointless — leave `frames`
          // unset so the renderer takes the static path. Two or more
          // = a real loop.
          if (framePngs.length >= 2) {
            frames = {
              pngs: framePngs,
              widthPx: CELL_W,
              heightPx: CELL_H,
              fps: CODEX_PET_IDLE_FPS,
            };
          }
        } catch {
          frames = undefined;
        }
        return { ansi, png, frames };
      }
    } catch {
      /* fall through to image fallback */
    }
  }

  // Image fallback — used when a sim has no walk sheet (legacy pipoya
  // sims that pre-date `org.simocracy.sim.sprite`) or when the codex
  // pet atlas decode failed for any reason. The simocracy.org client
  // always generates a 128×128 PNG idle thumbnail and uploads it as
  // `image` for codex pets, so even when this path runs the right pose
  // shows up.
  if (imageLink) {
    try {
      const buf = await fetchBlob(sim.did, imageLink);
      const { width, height, data } = decodePng(buf);
      // Old pipoya sims publish a 128×128 PNG that's a 4×-upscaled 32×32
      // pixel-art sprite. Detect and undo that with nearest-neighbour
      // downsampling.
      const scale = detectPixelArtScale(data, width, height, 8);
      let native: { data: Buffer; width: number; height: number } =
        scale > 1
          ? downscaleRgbaNearest(data, width, height, scale)
          : { data, width, height };
      // Non-pixel-art images (codex pet thumbnails, avatars from other
      // pipelines) come through at full resolution — box-downscale them
      // so the ANSI render fits in a typical terminal row budget.
      const longEdge = Math.max(native.width, native.height);
      if (scale === 1 && longEdge > NON_PIXEL_ART_TARGET_LONG_EDGE) {
        const k = NON_PIXEL_ART_TARGET_LONG_EDGE / longEdge;
        native = boxDownscaleRgba(
          native.data,
          native.width,
          native.height,
          Math.max(1, Math.round(native.width * k)),
          Math.max(1, Math.round(native.height * k)),
        );
      }
      return bundle(native.data, native.width, native.height);
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Subcommand keywords reserved by the `/sim` dispatcher. The dispatcher
 * routes these BEFORE falling through to `runLoadFlow`, but we also
 * guard the load flow itself against them as defense-in-depth — if a
 * future regression ever leaks one of these into `runLoadFlow`, the
 * user gets a "did you mean…?" hint instead of a misleading
 * "Searching for 'login'…" + indexer-fetch error.
 */
const RESERVED_SUBCOMMANDS = new Set([
  "help",
  "login",
  "logout",
  "whoami",
  "my",
  "mine",
  "unload",
  "clear",
  "status",
]);

async function loadSimByName(query: string): Promise<{
  matches: SimMatch[];
  loaded?: LoadedSim;
  error?: string;
}> {
  let matches: SimMatch[];
  try {
    matches = await searchSimsByName(query, { maxResults: 8 });
  } catch (err) {
    const msg = (err as Error).message;
    // Node's "fetch failed" is opaque — the user can't tell whether the
    // indexer is down, their network is down, or DNS is broken. Rewrite
    // it into something actionable.
    const friendly =
      msg === "fetch failed" || msg.includes("fetch failed")
        ? "could not reach the Simocracy indexer at simocracy-indexer-production.up.railway.app — check your internet connection"
        : msg;
    return { matches: [], error: `Indexer search failed: ${friendly}` };
  }
  if (matches.length === 0) {
    return { matches: [], error: `No sim found matching "${query}".` };
  }
  return { matches };
}

async function hydrateLoadedSim(match: SimMatch): Promise<LoadedSim> {
  // Fetch agents (constitution), style, sprite ANSI, handle, and the
  // simocracy.org navigation cheat-sheet in parallel.
  const [agents, style, sprite, handle, skill] = await Promise.all([
    fetchAgentsForSim(match.uri).catch(() => null) as Promise<AgentsRecord | null>,
    fetchStyleForSim(match.uri).catch(() => null) as Promise<StyleRecord | null>,
    renderSprite(match).catch(() => null),
    resolveHandle(match.did).catch(() => null),
    fetchSkillMd(),
  ]);

  return {
    uri: match.uri,
    did: match.did,
    rkey: match.rkey,
    name: match.sim.name,
    handle,
    spriteAnsi: sprite?.ansi,
    spritePng: sprite?.png
      ? {
          base64: sprite.png.data.toString("base64"),
          widthPx: sprite.png.widthPx,
          heightPx: sprite.png.heightPx,
        }
      : undefined,
    spriteFrames: sprite?.frames
      ? {
          pngBase64: sprite.frames.pngs.map((b) => b.toString("base64")),
          fps: sprite.frames.fps,
          widthPx: sprite.frames.widthPx,
          heightPx: sprite.frames.heightPx,
        }
      : undefined,
    shortDescription: agents?.shortDescription,
    description: agents?.description,
    style: style?.description,
    skillMd: skill.text,
    skillMdError: skill.text ? undefined : skill.error,
  };
}

/**
 * Build the bio text block that appears alongside (or below) the
 * sprite in the loaded-sim message: name + handle + AT-URI +
 * shortDescription. Indented two spaces so it lines up with the ANSI
 * sprite render. Used both as a standalone block (Image+Text
 * variant) and as the trailing portion of `formatSimSummary`.
 */
function formatSimBio(
  sim: LoadedSim,
  theme?: ExtensionContext["ui"]["theme"],
): string {
  const dim = theme?.fg("dim", "") ? (s: string) => theme.fg("dim", s) : (s: string) => s;
  const accent = theme?.fg("accent", "")
    ? (s: string) => theme.fg("accent", s)
    : (s: string) => s;
  const lines: string[] = [];
  lines.push(`  🐾 ${accent(sim.name)}${sim.handle ? dim(`  @${sim.handle}`) : ""} loaded—pi is now in character.`);
  lines.push(dim(`  ${sim.uri}`));
  if (sim.shortDescription) {
    lines.push("");
    lines.push("  " + sim.shortDescription.split("\n").join("\n  "));
  }
  return lines.join("\n");
}

function formatSimSummary(
  sim: LoadedSim,
  theme?: ExtensionContext["ui"]["theme"],
): string {
  const lines: string[] = [];
  if (sim.spriteAnsi) {
    lines.push(sim.spriteAnsi);
    lines.push("");
  }
  lines.push(formatSimBio(sim, theme));
  return lines.join("\n");
}

// The OpenTUI standalone animated viewer used to live here. It now ships
// alongside this file as `viewer.ts` for anyone who wants the full-window
// experience — run it manually with:
//
//     bun src/viewer.ts /tmp/pi-simocracy/<rkey>.json
//
// The default `/sim` flow renders inline ANSI art instead, so pi keeps the
// terminal it's already running in.

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const LoadSimToolParams = Type.Object({
  query: Type.String({
    description: "Sim name or AT-URI (at://did/org.simocracy.sim/rkey).",
    minLength: 1,
  }),
});

const ChatToolParams = Type.Object({
  message: Type.String({ description: "Message to send to the sim.", minLength: 1 }),
  query: Type.Optional(
    Type.String({
      description:
        "Sim name to chat with. Defaults to the currently loaded sim if omitted.",
    }),
  ),
});

const UnloadToolParams = Type.Object({});

const UpdateSimToolParams = Type.Object({
  shortDescription: Type.Optional(
    Type.String({
      description:
        "New short description for the sim's constitution. Max 300 chars; longer values will be truncated. Pass alongside `description` when rewriting the constitution; if you supply `description` without this, the existing short description (if any) is reused.",
      maxLength: 300,
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "New constitution body in markdown. Replaces the existing org.simocracy.agents record's `description`. Required when changing the constitution — a constitution with only a short description and no body is rejected.",
    }),
  ),
  style: Type.Optional(
    Type.String({
      description:
        "New speaking style description in markdown. Replaces the existing org.simocracy.style record's `description`. May be passed alone (style-only update) or together with `shortDescription` + `description` (constitution + style update).",
    }),
  ),
});

const PostCommentToolParams = Type.Object({
  subjectUri: Type.String({
    description:
      "AT-URI of the record to comment on. Accepts proposals (org.hypercerts.claim.activity), gatherings (org.simocracy.gathering), sims (org.simocracy.sim), decisions (org.simocracy.decision), or another comment URI for a nested reply. Get one by calling simocracy_lookup_record first if you don't already have it.",
    minLength: 1,
  }),
  text: Type.String({
    description:
      "The comment body. Plain text up to ~5000 chars. Write it as the loaded sim would speak \u2014 the sim's persona is already injected into your system prompt, so just say what they'd say.",
    minLength: 1,
    maxLength: 5000,
  }),
});

/**
 * Default cover image used by simocracy.org's `ProposalFormDialog` when the
 * user doesn't upload anything. We mirror that exactly so a pi-authored
 * proposal renders with the same banner as a webapp-authored one.
 */
const DEFAULT_PROPOSAL_BANNER_URI =
  "https://www.simocracy.org/ftc-sf-default.jpeg";

/**
 * Mirror of simocracy-v2's `appendBudgetToDescription` — markers verbatim
 * from `lib/budget-items.ts` so the block round-trips through the
 * webapp's `parseDescriptionWithBudget` reader untouched. We only
 * implement the *append* side here; pi-simocracy never parses
 * existing descriptions back out (proposals are create-only).
 *
 * Returns the description unchanged when `items` is empty or contains
 * no valid (non-empty name + positive amount) entries.
 */
const BUDGET_HEADER = "━━━ Budget Request ━━━";
const TOTAL_PREFIX = "━━━ Total: ";
const TOTAL_SUFFIX = " ━━━";

function formatProposalUsd(amount: number): string {
  const hasDecimals = !Number.isInteger(amount);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

function appendBudgetToDescription(
  description: string,
  items: Array<{ item: string; amountUsd: number }>,
): string {
  const valid = items.filter(
    (i) => i.item.trim() !== "" && i.amountUsd > 0 && Number.isFinite(i.amountUsd),
  );
  if (valid.length === 0) return description;
  const total = valid.reduce((sum, i) => sum + i.amountUsd, 0);
  const block = [
    BUDGET_HEADER,
    ...valid.map(
      (i) => `• ${i.item.trim()} — ${formatProposalUsd(i.amountUsd)}`,
    ),
    `${TOTAL_PREFIX}${formatProposalUsd(total)}${TOTAL_SUFFIX}`,
  ].join("\n");
  const base = description.trim();
  return base ? `${base}\n\n${block}` : block;
}

const PostProposalToolParams = Type.Object({
  title: Type.String({
    description:
      "Proposal title in the sim's voice. Required, max 256 chars. The sim is already in your system prompt — write the title as they'd phrase it.",
    minLength: 1,
    maxLength: 256,
  }),
  shortDescription: Type.String({
    description:
      "One- or two-sentence pitch for the proposal, in the sim's voice. Required, max 300 chars. Shows up in proposal lists on simocracy.org.",
    minLength: 1,
    maxLength: 300,
  }),
  description: Type.Optional(
    Type.String({
      description:
        "Long-form proposal body in the sim's voice. Plain text. Optional — pass when the user has discussed the project in detail. If `budgetItems` is also passed, an itemized budget block is appended automatically.",
    }),
  ),
  workScope: Type.Optional(
    Type.String({
      description:
        "Comma-separated tags describing the work scope (e.g. \"urban agriculture, food security\"). Optional. Stored as a bare string the same way simocracy.org's webapp writes it.",
    }),
  ),
  contributors: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description:
        "DIDs, handles, or freeform names of people credited as contributors. One entry per contributor. Optional.",
    }),
  ),
  budgetItems: Type.Optional(
    Type.Array(
      Type.Object({
        item: Type.String({
          minLength: 1,
          description: "What the line-item is funding (e.g. \"Solar panels\").",
        }),
        amountUsd: Type.Number({
          minimum: 0,
          description: "USD amount for this line-item. Must be > 0 to be included.",
        }),
      }),
      {
        description:
          "Itemized budget request. When provided, an `━━━ Budget Request ━━━` block is appended to `description` so it renders the same way simocracy.org's proposal form writes it. Pass when the user discussed a budget; omit when they didn't.",
      },
    ),
  ),
  imageUri: Type.Optional(
    Type.String({
      description:
        "https URL for the cover image. Defaults to the Simocracy banner if omitted. Image upload from disk is not supported — pass a URL or leave blank.",
    }),
  ),
});

const LookupRecordToolParams = Type.Object({
  query: Type.String({
    description:
      "AT-URI (at://did/collection/rkey) or fuzzy name to look up. AT-URI fetches the exact record from its owner's PDS; a name searches the indexer.",
    minLength: 1,
  }),
  kind: Type.Optional(
    Type.Union(
      [
        Type.Literal("auto"),
        Type.Literal("sim"),
        Type.Literal("proposal"),
        Type.Literal("gathering"),
        Type.Literal("decision"),
        Type.Literal("comment"),
      ],
      {
        description:
          "Restrict the search to one record kind. `auto` (default) searches sims + proposals + gatherings + decisions in parallel and returns the best match. `comment` is only meaningful with an AT-URI query \u2014 comments aren't full-text searchable.",
      },
    ),
  ),
  withComments: Type.Optional(
    Type.Boolean({
      description:
        "Include the full comment subtree in the response, with sim attribution joined from org.simocracy.history sidecars. Default true. Set false for a smaller, record-only response.",
    }),
  ),
});

export default async function simocracy(pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // System prompt injection — every turn the loaded sim's persona is appended.
  // After an unload, a one-shot override fires on the very next turn to break
  // character (otherwise the model imitates its own previous in-character
  // replies that are still in the conversation history).
  // -------------------------------------------------------------------------
  pi.on("before_agent_start", async (event) => {
    if (loadedSim) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${buildSimPrompt(loadedSim)}`,
      };
    }
    if (justUnloaded) {
      const formerName = justUnloaded;
      justUnloaded = null;
      const override = [
        ``,
        `# Roleplay ended`,
        `You were previously roleplaying as **${formerName}**, a Simocracy sim. That roleplay session has ended.`,
        `Drop the persona completely. Stop using ${formerName}'s speaking style, mannerisms, catchphrases, emoji, or vocabulary.`,
        `Resume your default behavior as pi, a coding assistant. Speak in your normal neutral voice from now on.`,
        `Earlier turns in this conversation will contain in-character replies from when ${formerName} was loaded — ignore that style; do not continue it.`,
      ].join("\n");
      return { systemPrompt: `${event.systemPrompt}${override}` };
    }
    return;
  });

  // -------------------------------------------------------------------------
  // Custom message renderer — shows the sprite + bio inline in the chat.
  //
  // Two render paths, picked per-call:
  //
  //   1. Inline graphics (preferred when supported). Terminals that
  //      advertise the Kitty graphics protocol (Kitty, Ghostty, WezTerm,
  //      Konsole) or iTerm2's inline-image protocol get a real PNG of
  //      the sprite via pi-tui's `Image` component, stacked above the
  //      bio text in a `Box`. Pixels are crisp, scaling is the
  //      terminal's job.
  //
  //   2. ANSI half-blocks (universal fallback). Everything else —
  //      Apple Terminal, tmux without passthrough, plain SSH, dumb
  //      pipes — falls back to the existing `▀`/`▄` half-block art.
  //
  // Override with `SIMOCRACY_INLINE_GRAPHICS=ansi` to force the
  // half-block path even when the terminal supports inline graphics
  // (handy for screenshots, demo recordings, or terminals that
  // *advertise* support but render glitchily).
  // -------------------------------------------------------------------------
  const inlineGraphicsMode =
    (process.env.SIMOCRACY_INLINE_GRAPHICS ?? "auto").toLowerCase();
  pi.registerMessageRenderer<SimLoadedDetails>("simocracy_sim_loaded", (message, _opts, theme) => {
    const details = (message.details as SimLoadedDetails | undefined) ?? {};
    const body =
      details.body ?? (typeof message.content === "string" ? message.content : "");

    // Decide whether to use the inline-graphics path. Auto-detect by
    // default; honour the env-var override either direction.
    const caps = getCapabilities();
    const wantGraphics =
      inlineGraphicsMode === "auto"
        ? caps.images !== null
        : inlineGraphicsMode === "kitty" || inlineGraphicsMode === "iterm2";
    if (wantGraphics && details.spritePngBase64 && details.bioText) {
      // Pi-tui's Image needs a fallback colour for terminals that
      // claim image support but later fail to render — we use the
      // theme's `dim` so the placeholder text is unobtrusive.
      const imageTheme: ImageTheme = {
        fallbackColor: theme.fg("dim", "") ? (s: string) => theme.fg("dim", s) : (s: string) => s,
      };
      const box = new Box(0, 0);

      // If this message owns the active animation slot, mount a live
      // `AnimatedImage` (cycles frames, owns its own setInterval). We
      // cache the component on `currentAnimation.component` so we
      // don't spawn a fresh timer on every re-render of the message
      // (pi-tui calls the renderer again on expand/collapse, theme
      // change, etc.).
      //
      // For every other case — older loaded-sim messages whose key
      // doesn't match, sims without animation frames, or animation
      // disabled via env — we mount a static `Image` of the idle
      // frame, which freezes gracefully.
      const isActiveAnimation =
        currentAnimation &&
        capturedTui !== null &&
        details.animationKey !== undefined &&
        currentAnimation.key === details.animationKey;
      if (isActiveAnimation) {
        if (!currentAnimation!.component) {
          currentAnimation!.component = new AnimatedImage({
            frames: currentAnimation!.frames,
            dimensions: {
              widthPx: currentAnimation!.widthPx,
              heightPx: currentAnimation!.heightPx,
            },
            maxWidthCells: spriteWidthCells,
            imageId: currentAnimation!.imageId,
            fps: currentAnimation!.fps,
            tui: capturedTui!,
          });
        }
        box.addChild(currentAnimation!.component);
      } else {
        // Source PNG is at full native resolution (192×208 for codex
        // pets, 32×32 for pipoya). The terminal scales it down to
        // `spriteWidthCells` cells wide on display — we never
        // pre-downsample on our side, so quality is preserved.
        box.addChild(
          new Image(
            details.spritePngBase64,
            "image/png",
            imageTheme,
            { maxWidthCells: spriteWidthCells },
            {
              widthPx: details.spritePngWidth ?? 0,
              heightPx: details.spritePngHeight ?? 0,
            },
          ),
        );
      }
      box.addChild(new Text(details.bioText, 0, 0));
      return box;
    }
    return new Text(body, 0, 0);
  });

  // -------------------------------------------------------------------------
  // Slash command: /sim
  //
  // All extension commands are namespaced under /sim to avoid colliding
  // with pi's built-in slash commands (notably `/login` for Anthropic
  // OAuth and `/logout`). That namespacing also makes it unambiguous to
  // users that `/sim login` signs them into their ATProto / Bluesky
  // account, NOT into Anthropic.
  // -------------------------------------------------------------------------
  pi.registerCommand("sim", {
    description:
      "Simocracy: load sims, edit your own sim's constitution/style, sign into ATProto. `/sim help` for the full list.",
    handler: async (args, ctx) => {
      // Strip zero-width / format characters that survive `.trim()` —
      // a stray U+200B (ZWSP) glued onto "login" by a paste from a
      // chat client is enough to make `arg === "login"` fail and
      // route the request through `runLoadFlow` as if it were a sim
      // name. We match subcommand keywords against the *lowercased*
      // form, but pass the original-case clean arg through to handlers
      // (sim names are user-facing strings; preserve their case).
      const arg = args
        .trim()
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "");
      const argLower = arg.toLowerCase();
      if (!arg || argLower === "help" || argLower === "--help") {
        ctx.ui.notify(
          "Sim:\n" +
            "  /sim <name>            load a sim (e.g. /sim mr meow)\n" +
            "  /sim unload            stop roleplaying\n" +
            "  /sim status            show currently loaded sim\n" +
            "\n" +
            "Refining your sim's constitution / speaking style:\n" +
            "  Just chat with pi about what you want to change — pi calls\n" +
            "  the simocracy_update_sim tool to write the new constitution or\n" +
            "  style to your PDS. Requires /sim login + sim ownership.\n" +
            "\n" +
            "Sign in with ATProto / Bluesky (not Anthropic — pi's built-in /login\n" +
            "does that). Required before pi can update your sim:\n" +
            "  /sim login [handle]    OAuth loopback flow (e.g. /sim login alice.bsky.social)\n" +
            "  /sim logout            clear local session\n" +
            "  /sim whoami            show signed-in handle/DID\n" +
            "\n" +
            "Browse your own sims (requires /sim login):\n" +
            "  /sim my                pick from sims you own (auto-loads if just one)\n" +
            "  /sim my <name>         fuzzy-load by name within your sims",
          "info",
        );
        return;
      }
      // ATProto auth subcommands — must come BEFORE the sim-name
      // fallthrough (`runLoadFlow`) so we don't accidentally treat
      // "login" as a sim name to load from the indexer. Match on
      // `argLower` so `/sim Login` and `/sim LOGIN` route the same way.
      if (argLower === "login" || argLower.startsWith("login ") || argLower.startsWith("login\t")) {
        const rest = arg.slice("login".length).trim();
        await runLogin(ctx, rest);
        return;
      }
      if (argLower === "logout") {
        await runLogout(ctx);
        return;
      }
      if (argLower === "whoami") {
        await runWhoami(ctx);
        return;
      }
      if (argLower === "my" || argLower === "mine" || argLower.startsWith("my ") || argLower.startsWith("my\t") || argLower.startsWith("mine ") || argLower.startsWith("mine\t")) {
        const headLen = argLower.startsWith("mine") ? 4 : 2;
        const rest = arg.slice(headLen).trim();
        await runMySimsCommand(pi, ctx, rest);
        return;
      }
      if (argLower === "unload" || argLower === "clear") {
        if (!loadedSim) {
          ctx.ui.notify("No sim loaded.", "info");
          return;
        }
        const name = loadedSim.name;
        loadedSim = null;
        justUnloaded = name;
        stopCurrentAnimation();
        ctx.ui.setStatus("simocracy", undefined);
        ctx.ui.setWidget("simocracy", undefined);
        ctx.ui.notify(`Unloaded ${name}. Pi will break character on the next reply.`, "info");
        return;
      }
      if (argLower === "status") {
        if (!loadedSim) {
          ctx.ui.notify("No sim loaded. Try `/sim mr meow`.", "info");
          return;
        }
        await postSimToChat(pi, ctx, loadedSim, /*reload=*/ false);
        return;
      }
      await runLoadFlow(pi, ctx, arg);
    },
  });

  // -------------------------------------------------------------------------
  // (Removed) top-level /login, /logout, /whoami slash commands.
  //
  // These collided with pi's own built-in `/login` (Anthropic OAuth) and
  // `/logout`, which made pi emit "Skipping in autocomplete" warnings on
  // every boot and silently degraded discoverability of these handlers.
  // The auth flow now lives under `/sim login`, `/sim logout`,
  // `/sim whoami` — no collision, and the namespacing makes it explicit
  // to users that they're signing into their ATProto / Bluesky account,
  // not Anthropic. See the dispatcher in the `/sim` registerCommand
  // above.
  //
  // The `runLogin` / `runLogout` / `runWhoami` helpers in src/auth/
  // commands.ts are unchanged — only the slash-command surface moved.
  // -------------------------------------------------------------------------
  // (no top-level registration — the auth helpers `runLogin`, `runLogout`,
  // `runWhoami` are dispatched from inside the `/sim` handler above.)

  // -------------------------------------------------------------------------
  // Tool: simocracy_load_sim
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_load_sim",
    label: "Load Simocracy sim",
    description:
      "Load a Simocracy sim by name into the current pi session. Pi will stay in character as that sim until simocracy_unload_sim is called. Renders the sim's sprite in the terminal and injects the sim's constitution + speaking style into the system prompt.",
    parameters: LoadSimToolParams,
    async execute(_id, { query }, _signal, _onUpdate, ctx) {
      const sim = await tryLoadFromQuery(query);
      if (!sim) {
        throw new Error(`No sim found matching "${query}".`);
      }
      loadedSim = sim;
      if (ctx.hasUI) {
        await postSimToChat(pi, ctx, sim, /*reload=*/ true);
      }
      const summary = [
        `Loaded sim: ${sim.name}${sim.handle ? ` (@${sim.handle})` : ""}`,
        `URI: ${sim.uri}`,
        sim.shortDescription ? `\nShort description:\n${sim.shortDescription}` : "",
        sim.description ? `\nConstitution:\n${sim.description}` : "",
        sim.style ? `\nSpeaking style:\n${sim.style}` : "",
        `\nFrom now on, stay in character as ${sim.name}.`,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        content: [{ type: "text" as const, text: summary }],
        details: { uri: sim.uri, did: sim.did, rkey: sim.rkey, name: sim.name },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_unload_sim
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_unload_sim",
    label: "Unload Simocracy sim",
    description:
      "Stop roleplaying as the currently loaded Simocracy sim. After this call, pi reverts to its default behavior.",
    parameters: UnloadToolParams,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!loadedSim) {
        return {
          content: [{ type: "text" as const, text: "No sim loaded." }],
          details: {},
        };
      }
      const name = loadedSim.name;
      loadedSim = null;
      justUnloaded = name;
      stopCurrentAnimation();
      if (ctx.hasUI) {
        ctx.ui.setStatus("simocracy", undefined);
        ctx.ui.setWidget("simocracy", undefined);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Unloaded ${name}. Drop the persona completely from your next reply onward — stop using their speaking style, mannerisms, emoji, or vocabulary. Speak in your default neutral voice.`,
          },
        ],
        details: { unloaded: name },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_chat — one-shot, doesn't change session persona.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_chat",
    label: "Chat with Simocracy sim",
    description:
      "Send a single message to a Simocracy sim and return its response. Uses OpenRouter directly so it doesn't change the current pi session's persona. Useful for getting a sim's opinion as quoted text.",
    parameters: ChatToolParams,
    async execute(_id, { message, query }) {
      let sim: LoadedSim | null = loadedSim;
      if (query) {
        sim = await tryLoadFromQuery(query);
      }
      if (!sim) {
        throw new Error(
          query
            ? `No sim found matching "${query}".`
            : "No sim loaded. Pass `query` or call simocracy_load_sim first.",
        );
      }
      const messages: ChatMessage[] = [
        { role: "system", content: buildSimPrompt(sim) },
        { role: "user", content: message },
      ];
      const reply = await openRouterComplete(messages, { maxTokens: 600 });
      return {
        content: [{ type: "text" as const, text: `${sim.name} says:\n\n${reply}` }],
        details: { name: sim.name, uri: sim.uri },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_update_sim — write a new constitution and/or speaking
  // style for the loaded sim to the signed-in user's PDS.
  //
  // This is the *only* persona-edit surface this extension exposes. The
  // older Interview Modal + Training Lab pipelines (`/sim interview`,
  // `/sim train …`) were removed in favour of this single tool: pi (the
  // coding agent) chats with the user about how to refine the sim, then
  // calls this tool with the new short description / constitution body /
  // speaking style. The model itself does the rewriting; we just persist
  // the result and update the in-memory persona so the next reply uses it.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_update_sim",
    label: "Update Simocracy sim constitution / style",
    description:
      "Update the currently loaded Simocracy sim's constitution (short description + markdown body) and/or speaking style on the user's ATProto PDS. Use this when the user asks to refine, rewrite, extend, or fix any part of the loaded sim's persona — e.g. 'add a red line about animal welfare to the constitution', 'rewrite the speaking style to drop the lenny faces', 'shorten the constitution and emphasise renewable energy'. Pass `description` (with optional `shortDescription`) to update the constitution; pass `style` to update the speaking style; pass any combination. Requires the user to be signed in via /sim login AND to own the loaded sim — the call will fail otherwise. The new persona takes effect on the very next reply, no reload needed.",
    parameters: UpdateSimToolParams,
    async execute(_id, { shortDescription, description, style }) {
      if (!loadedSim) {
        throw new Error(
          "No sim loaded. Call simocracy_load_sim first — the user must load the sim they want to edit.",
        );
      }
      const wantsConstitution =
        description !== undefined || shortDescription !== undefined;
      const wantsStyle = style !== undefined;
      if (!wantsConstitution && !wantsStyle) {
        throw new Error(
          "Pass at least one of `description`, `shortDescription`, `style`. Empty calls are rejected.",
        );
      }
      // Owner + auth gate. The same precondition is re-checked at the
      // XRPC call site in writes.ts (defense-in-depth) but we want a
      // human-readable failure here before we touch the network.
      let auth;
      try {
        auth = await assertCanWriteToSim(loadedSim, { action: "update" });
      } catch (err) {
        if (err instanceof NotSignedInError || err instanceof NotSimOwnerError) {
          throw new Error(err.message);
        }
        throw err;
      }
      let pdsAgent;
      try {
        ({ agent: pdsAgent } = await getAuthenticatedAgent());
      } catch (err) {
        if (err instanceof NotSignedInError) throw new Error(err.message);
        throw new Error(`ATProto auth failed: ${(err as Error).message}`);
      }

      const updates: string[] = [];
      const details: Record<string, unknown> = {
        uri: loadedSim.uri,
        did: loadedSim.did,
        rkey: loadedSim.rkey,
        name: loadedSim.name,
      };

      // Constitution update — org.simocracy.agents. Lexicon stores both
      // shortDescription (≤300 chars) and description (full markdown). If
      // the caller only passed one of those, fall back to the existing
      // value on the loaded sim so we never end up with a half-empty
      // record.
      if (wantsConstitution) {
        const finalShort =
          shortDescription !== undefined
            ? shortDescription
            : loadedSim.shortDescription ?? "";
        const finalBody =
          description !== undefined ? description : loadedSim.description ?? "";
        if (!finalBody.trim()) {
          throw new Error(
            "Cannot write an empty constitution body. Pass `description` with the new markdown body.",
          );
        }
        const existingRkey = await findRkeyForSim(
          pdsAgent,
          auth.did,
          "org.simocracy.agents",
          loadedSim.uri,
        ).catch(() => null);
        try {
          if (existingRkey) {
            const res = await updateAgents({
              agent: pdsAgent,
              did: auth.did,
              rkey: existingRkey,
              simUri: loadedSim.uri,
              simCid: "",
              shortDescription: finalShort,
              description: finalBody,
            });
            details.agentsUri = res.uri;
            updates.push(`Updated constitution (org.simocracy.agents/${existingRkey}).`);
          } else {
            const res = await createAgents({
              agent: pdsAgent,
              did: auth.did,
              simUri: loadedSim.uri,
              simCid: "",
              shortDescription: finalShort,
              description: finalBody,
            });
            details.agentsUri = res.uri;
            updates.push(`Created constitution (org.simocracy.agents/${res.rkey}).`);
          }
        } catch (err) {
          throw new Error(`Constitution write failed: ${(err as Error).message}`);
        }
        // Mutate in-memory persona so the next `before_agent_start` event
        // injects the new constitution without requiring an unload/reload.
        loadedSim.shortDescription = finalShort;
        loadedSim.description = finalBody;
      }

      // Speaking-style update — org.simocracy.style. Single field.
      if (wantsStyle) {
        const finalStyle = style ?? "";
        if (!finalStyle.trim()) {
          throw new Error(
            "Cannot write an empty speaking style. Pass `style` with the new markdown body.",
          );
        }
        const existingRkey = await findRkeyForSim(
          pdsAgent,
          auth.did,
          "org.simocracy.style",
          loadedSim.uri,
        ).catch(() => null);
        try {
          if (existingRkey) {
            const res = await updateStyle({
              agent: pdsAgent,
              did: auth.did,
              rkey: existingRkey,
              simUri: loadedSim.uri,
              simCid: "",
              description: finalStyle,
            });
            details.styleUri = res.uri;
            updates.push(`Updated speaking style (org.simocracy.style/${existingRkey}).`);
          } else {
            const res = await createStyle({
              agent: pdsAgent,
              did: auth.did,
              simUri: loadedSim.uri,
              simCid: "",
              description: finalStyle,
            });
            details.styleUri = res.uri;
            updates.push(`Created speaking style (org.simocracy.style/${res.rkey}).`);
          }
        } catch (err) {
          throw new Error(`Style write failed: ${(err as Error).message}`);
        }
        loadedSim.style = finalStyle;
      }

      const text = [
        `Updated ${loadedSim.name} on ${auth.handle ? `@${auth.handle}` : auth.did}'s PDS:`,
        ...updates.map((u) => `  - ${u}`),
        ``,
        `The new persona takes effect on your next reply.`,
      ].join("\n");
      details.updates = updates;
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_post_comment
  //
  // Writes a comment on behalf of the currently loaded sim. Two records
  // are written to the user's PDS:
  //
  //   1. org.impactindexer.review.comment   the comment itself (same wire
  //      shape simocracy.org's webapp writes today, so it threads + renders
  //      identically there).
  //   2. org.simocracy.history               sidecar with type="comment",
  //      simUris=[loadedSim], subjectUri=<comment uri>. Renderers that
  //      understand the join (simocracy.org, when the planned change
  //      lands) display a sim badge; renderers that don't see a regular
  //      user comment — graceful degradation, zero lexicon changes.
  //
  // See `docs/SIM_AUTHORED_COMMENTS.md` for the full design.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_post_comment",
    label: "Post a comment as the loaded Simocracy sim",
    description:
      "Post a comment on a Simocracy record (proposal / gathering / sim / decision / another comment) as the currently loaded sim. The comment text should sound like the sim \u2014 their persona is already in your system prompt. Writes the comment to the user's PDS plus an org.simocracy.history sidecar that attributes the comment to the loaded sim (no impactindexer lexicon changes needed). Use this when the user asks the sim to weigh in on something, comment on a proposal, reply to another comment, or leave their opinion. Requires /sim login + ownership of the loaded sim.",
    parameters: PostCommentToolParams,
    async execute(_id, { subjectUri, text }) {
      if (!loadedSim) {
        throw new Error(
          "No sim loaded. Call simocracy_load_sim first \u2014 comments are written on behalf of a specific sim.",
        );
      }
      let auth;
      try {
        auth = await assertCanWriteToSim(loadedSim, { action: "post a comment as" });
      } catch (err) {
        if (err instanceof NotSignedInError || err instanceof NotSimOwnerError) {
          throw new Error(err.message);
        }
        throw err;
      }
      let pdsAgent;
      try {
        ({ agent: pdsAgent } = await getAuthenticatedAgent());
      } catch (err) {
        if (err instanceof NotSignedInError) throw new Error(err.message);
        throw new Error(`ATProto auth failed: ${(err as Error).message}`);
      }

      // Best-effort fetch of the parent record so we can denormalize its
      // title onto the history sidecar (drives the timeline UX in
      // simocracy.org). Failure is non-fatal — the comment goes through
      // either way, the badge just won't carry a title.
      let parentName: string | undefined;
      let parentCollection: string | undefined;
      try {
        const parsed = parseAtUri(subjectUri);
        parentCollection = parsed.collection;
        const { getRecordFromPds } = await import("./simocracy.ts");
        const parentValue = await getRecordFromPds<Record<string, unknown>>(
          parsed.did,
          parsed.collection,
          parsed.rkey,
        );
        parentName = bestNameForRecord(parsed.collection, parentValue);
      } catch {
        /* non-fatal — leave parentName undefined */
      }

      let comment;
      try {
        comment = await createComment({
          agent: pdsAgent,
          did: auth.did,
          subjectUri,
          text,
        });
      } catch (err) {
        throw new Error(`Comment write failed: ${(err as Error).message}`);
      }

      let attributionUri: string | undefined;
      let attributionWarning: string | undefined;
      try {
        const history = await createCommentHistory({
          agent: pdsAgent,
          did: auth.did,
          commentUri: comment.uri,
          simUri: loadedSim.uri,
          simName: loadedSim.name,
          text,
          proposalTitle: parentName,
          parentCollection,
          parentName,
        });
        attributionUri = history.uri;
      } catch (err) {
        // Don't fail the whole call — the comment is already on the user's
        // PDS. The sidecar can be re-written later. Surface the warning so
        // the LLM can decide whether to retry.
        attributionWarning = `Sim-attribution sidecar failed: ${(err as Error).message}`;
      }

      const lines = [
        `Posted comment as ${loadedSim.name}${loadedSim.handle ? ` (@${loadedSim.handle})` : ""}:`,
        `  comment URI: ${comment.uri}`,
      ];
      if (parentName) lines.push(`  on:          ${parentName} (${subjectUri})`);
      else lines.push(`  on:          ${subjectUri}`);
      if (attributionUri) {
        lines.push(`  attribution: ${attributionUri}  (org.simocracy.history sidecar)`);
      } else if (attributionWarning) {
        lines.push(`  WARNING:     ${attributionWarning}`);
        lines.push(
          `               The comment is posted but will appear unattributed until a history sidecar is written.`,
        );
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          commentUri: comment.uri,
          commentRkey: comment.rkey,
          subjectUri,
          parentName,
          parentCollection,
          simUri: loadedSim.uri,
          simName: loadedSim.name,
          attributionUri,
          attributionWarning,
        },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_post_proposal
  //
  // Submit a new funding proposal on behalf of the loaded sim. Two
  // records are written to the user's PDS, mirroring simocracy_post_comment:
  //
  //   1. org.hypercerts.claim.activity   the proposal itself, in the same
  //      wire shape simocracy.org's ProposalFormDialog writes today, so it
  //      renders identically in the webapp.
  //   2. org.simocracy.history           sidecar with type="proposal",
  //      simUris=[loadedSim], subjectUri=<proposal uri>. Renderers that
  //      understand the join show the sim badge; others see a regular
  //      proposal — graceful degradation, zero lexicon changes.
  //
  // See `docs/SIM_AUTHORED_PROPOSALS.md` for the full design.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_post_proposal",
    label: "Submit a Simocracy proposal as the loaded sim",
    description:
      "Submit a new funding proposal to Simocracy on behalf of the currently loaded sim. The sim should write the title + shortDescription + description in their own voice (their persona is already in your system prompt). Writes the proposal to the user's PDS plus an org.simocracy.history sidecar attributing the draft to the loaded sim. Use this when the user asks the sim to draft, propose, or submit a proposal — e.g. \"Mr Meow, propose a cat sanctuary\" or \"draft a proposal for solar panels\". Pass `budgetItems` if a budget request was discussed; pass `workScope` for tag-style categorization; pass `contributors` for credited humans. Image is optional and URL-only (the default Simocracy banner is used otherwise). Requires /sim login + a loaded sim the user owns.",
    parameters: PostProposalToolParams,
    async execute(
      _id,
      { title, shortDescription, description, workScope, contributors, budgetItems, imageUri },
    ) {
      if (!loadedSim) {
        throw new Error(
          "No sim loaded. Call simocracy_load_sim first — proposals are submitted on behalf of a specific sim.",
        );
      }
      let auth;
      try {
        auth = await assertCanWriteToSim(loadedSim, { action: "post a proposal as" });
      } catch (err) {
        if (err instanceof NotSignedInError || err instanceof NotSimOwnerError) {
          throw new Error(err.message);
        }
        throw err;
      }
      let pdsAgent;
      try {
        ({ agent: pdsAgent } = await getAuthenticatedAgent());
      } catch (err) {
        if (err instanceof NotSignedInError) throw new Error(err.message);
        throw new Error(`ATProto auth failed: ${(err as Error).message}`);
      }

      // Resolve the cover image — either an LLM-supplied https URL or
      // the simocracy.org default banner. Reject non-https schemes
      // (data:, javascript:, file://) defensively even though the only
      // real downstream consumer is the webapp's <Image> component.
      let imageRef: { $type: "org.hypercerts.defs#uri"; uri: string };
      if (imageUri !== undefined) {
        const trimmed = imageUri.trim();
        if (!/^https:\/\//i.test(trimmed)) {
          throw new Error(
            `imageUri must be an https URL (got "${trimmed}"). Pass an https URL, or omit imageUri to use the default Simocracy banner.`,
          );
        }
        imageRef = { $type: "org.hypercerts.defs#uri", uri: trimmed };
      } else {
        imageRef = { $type: "org.hypercerts.defs#uri", uri: DEFAULT_PROPOSAL_BANNER_URI };
      }

      // Append the budget block (if any) to the user-authored description,
      // exactly the same way simocracy.org's ProposalFormDialog does.
      const baseDescription = description?.trim() ?? "";
      const finalDescription = budgetItems
        ? appendBudgetToDescription(baseDescription, budgetItems)
        : baseDescription;

      // Build contributors in the lexicon shape:
      // `Array<{ contributorIdentity: string }>`. Drop blank entries.
      const contributorRecords =
        contributors && contributors.length > 0
          ? contributors
              .map((c) => c.trim())
              .filter((c) => c.length > 0)
              .map((contributorIdentity) => ({ contributorIdentity }))
          : undefined;

      let proposal;
      try {
        proposal = await createProposal({
          agent: pdsAgent,
          did: auth.did,
          title,
          shortDescription,
          description: finalDescription || undefined,
          workScope: workScope?.trim() || undefined,
          contributors:
            contributorRecords && contributorRecords.length > 0
              ? contributorRecords
              : undefined,
          image: imageRef,
        });
      } catch (err) {
        throw new Error(`Proposal write failed: ${(err as Error).message}`);
      }

      let sidecarUri: string | undefined;
      let sidecarWarning: string | undefined;
      try {
        const history = await createProposalHistory({
          agent: pdsAgent,
          did: auth.did,
          proposalUri: proposal.uri,
          proposalTitle: title,
          simUri: loadedSim.uri,
          simName: loadedSim.name,
          content: finalDescription || shortDescription,
        });
        sidecarUri = history.uri;
      } catch (err) {
        // Don't roll back — the proposal is already on the user's PDS.
        // The sidecar can be re-written later. Surface the warning so the
        // LLM can decide whether to retry.
        sidecarWarning = `Sim-attribution sidecar failed: ${(err as Error).message}`;
      }

      const lines = [
        `Submitted proposal as ${loadedSim.name}${loadedSim.handle ? ` (@${loadedSim.handle})` : ""}:`,
        `  title:        ${title}`,
        `  proposal URI: ${proposal.uri}`,
        `  image:        ${imageRef.uri}`,
      ];
      if (sidecarUri) {
        lines.push(`  attribution:  ${sidecarUri}  (org.simocracy.history sidecar)`);
      } else if (sidecarWarning) {
        lines.push(`  WARNING:      ${sidecarWarning}`);
        lines.push(
          `                The proposal is posted but will appear unattributed until a history sidecar is written.`,
        );
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          proposalUri: proposal.uri,
          proposalRkey: proposal.rkey,
          proposalCid: proposal.cid,
          title,
          shortDescription,
          imageUri: imageRef.uri,
          workScope: workScope?.trim() || undefined,
          contributors: contributorRecords,
          budgetItemCount: budgetItems?.length ?? 0,
          simUri: loadedSim.uri,
          simName: loadedSim.name,
          sidecarUri,
          sidecarWarning,
        },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: simocracy_lookup_record
  //
  // Look up a sim / proposal / gathering / decision / comment by AT-URI
  // (exact, fetched from the owner's PDS) or by fuzzy name (fan-out
  // search across both indexers). Returns the record + comment subtree
  // with sim attribution joined from org.simocracy.history sidecars.
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "simocracy_lookup_record",
    label: "Look up a Simocracy record",
    description:
      "Fetch a Simocracy record (sim, proposal, gathering, decision, or comment) by AT-URI or fuzzy name and return its details plus the full comment subtree with sim attribution joined. Use this before `simocracy_post_comment` to find the right `subjectUri`, to inspect what's been said about something, or to read a specific comment thread. Comments authored by sims are flagged with their sim name and AT-URI in the response, so you can tell at a glance which opinions are human and which are sim.",
    parameters: LookupRecordToolParams,
    async execute(_id, { query, kind, withComments }) {
      const { result, alternatives } = await lookupRecord(query, {
        kind: (kind ?? "auto") as LookupKind,
        withComments: withComments ?? true,
      });
      if (!result) {
        const tail = alternatives.length
          ? `\n\nClosest alternatives:\n${alternatives
              .map((a) => `  - [${a.kind}] ${a.name || "(untitled)"}  ${a.uri}`)
              .join("\n")}`
          : "";
        throw new Error(
          `No record matching "${query}" (kind=${kind ?? "auto"}).${tail}`,
        );
      }
      return {
        content: [{ type: "text" as const, text: formatLookupResult(result, alternatives) }],
        details: {
          kind: result.kind,
          uri: result.uri,
          did: result.did,
          rkey: result.rkey,
          collection: result.collection,
          name: result.name,
          ownerHandle: result.ownerHandle,
          attribution: result.attribution,
          parent: result.parent,
          commentCount: result.comments?.length ?? 0,
          simAuthoredCommentCount:
            result.comments?.filter((c) => c.simUri).length ?? 0,
          alternatives: alternatives.map((a) => ({
            kind: a.kind,
            uri: a.uri,
            name: a.name,
          })),
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Lookup-result formatter
//
// Renders a `LookupResult` as a compact, LLM-friendly markdown block.
// Calling out sim-authored comments with a 🐾 prefix is the whole
// point of the human-vs-sim distinction described in
// docs/SIM_AUTHORED_COMMENTS.md — keep it visually distinct from plain
// `@handle` lines.
// ---------------------------------------------------------------------------

interface SearchHitForFormat {
  kind: string;
  uri: string;
  name: string;
}

function formatLookupResult(
  result: LookupResult,
  alternatives: SearchHitForFormat[] = [],
): string {
  const lines: string[] = [];
  const kindLabel = result.kind.toUpperCase();
  const ownerLabel = result.ownerHandle ? `@${result.ownerHandle}` : result.did;
  lines.push(`# [${kindLabel}] ${result.name || "(untitled)"}`);
  lines.push(`- URI:   ${result.uri}`);
  lines.push(`- Owner: ${ownerLabel} (${result.did})`);

  // Kind-specific structured fields (status, treasury, dates, contributors
  // — the operationally important stuff that doesn't fit in a generic
  // shortDescription block). Rendered as a compact `Field: value` table.
  const v = result.value;
  const facts = collectKindFacts(result.kind, v);
  if (facts.length > 0) {
    lines.push("");
    for (const [k, val] of facts) lines.push(`- ${k}: ${val}`);
  }

  // Long-form summary (shortDescription / description / context). Capped at
  // ~25 lines so a verbose gathering context doesn't drown the rest of the
  // tool output.
  const longText =
    (typeof v.shortDescription === "string" && v.shortDescription) ||
    (typeof v.description === "string" && v.description) ||
    (typeof v.context === "string" && v.context) ||
    "";
  if (longText.trim()) {
    const trimmed = longText.split("\n").slice(0, 25).join("\n");
    lines.push("");
    lines.push("## Summary");
    lines.push(trimmed);
    if (longText.split("\n").length > 25) {
      lines.push("… (truncated)");
    }
  }

  // Council sims, suggested templates, etc — references the LLM may want
  // to drill into via another simocracy_lookup_record call.
  const refBlocks = collectKindRefs(result.kind, v);
  for (const block of refBlocks) {
    lines.push("");
    lines.push(`## ${block.title}`);
    for (const ref of block.refs) lines.push(`- ${ref}`);
  }

  // For comments — surface text + parent + attribution.
  if (result.kind === "comment") {
    lines.push("");
    lines.push("## Comment text");
    lines.push(((v.text as string) || "").trim() || "(empty)");
    if (result.attribution) {
      lines.push("");
      lines.push(
        `🐾 Posted on behalf of sim **${result.attribution.simName}** (${result.attribution.simUri})`,
      );
    } else {
      lines.push("");
      lines.push(`Posted by ${ownerLabel} (no sim attribution).`);
    }
    if (result.parent) {
      lines.push("");
      lines.push(
        `## Parent (${result.parent.collection})\n- ${result.parent.name || "(untitled)"}\n- ${result.parent.uri}`,
      );
    }
  }

  // Comment subtree summary.
  if (result.comments && result.comments.length > 0) {
    const simCount = result.comments.filter((c) => c.simUri).length;
    const humanCount = result.comments.length - simCount;
    lines.push("");
    lines.push(
      `## Comments (${result.comments.length} total — ${humanCount} human, ${simCount} sim)`,
    );
    // Show up to 25 most recent comments, oldest first within that window.
    const shown = result.comments.slice(-25);
    for (const c of shown) {
      lines.push(formatCommentLine(c));
    }
    if (result.comments.length > shown.length) {
      lines.push(
        `… ${result.comments.length - shown.length} earlier comment(s) omitted from this preview.`,
      );
    }
  } else if (result.kind !== "comment") {
    lines.push("");
    lines.push("_No comments yet._");
  }

  if (alternatives.length > 0) {
    lines.push("");
    lines.push("## Other matches");
    for (const a of alternatives) {
      lines.push(`- [${a.kind}] ${a.name || "(untitled)"}  ${a.uri}`);
    }
  }

  return lines.join("\n");
}

/**
 * Per-kind structured facts — status, treasury, allocation mechanism, etc.
 * Returned as `[label, value]` pairs so the formatter can render them as a
 * compact key/value list. Only fields with actual values are included; absent
 * or empty fields are omitted entirely so the output stays tight.
 */
function collectKindFacts(
  kind: string,
  v: Record<string, unknown>,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const str = (k: string): string | undefined => {
    const x = v[k];
    return typeof x === "string" && x.trim() ? x : undefined;
  };
  const num = (k: string): number | undefined => {
    const x = v[k];
    return typeof x === "number" ? x : undefined;
  };
  const arr = <T = unknown>(k: string): T[] => {
    const x = v[k];
    return Array.isArray(x) ? (x as T[]) : [];
  };
  switch (kind) {
    case "gathering": {
      // Status · type · mechanism on one row — these are the at-a-glance fields.
      const statusBits = [
        str("status"),
        str("gatheringType"),
        str("allocationMechanism"),
      ].filter(Boolean) as string[];
      if (statusBits.length) out.push(["Status", statusBits.join(" · ")]);
      const treasury = num("treasuryUsd");
      if (treasury !== undefined) out.push(["Treasury", `$${treasury.toLocaleString()} USD`]);
      const dates = str("dates");
      if (dates) out.push(["Dates", dates]);
      const location = str("location");
      if (location) out.push(["Location", location]);
      const url = str("url");
      if (url) out.push(["URL", url]);
      const appRoute = str("appRoute");
      if (appRoute) out.push(["App route", appRoute]);
      const collectionUri = str("collectionUri");
      if (collectionUri) out.push(["Proposal collection", collectionUri]);
      const scopeBits = [
        str("simScope") && `sims=${str("simScope")}`,
        str("proposalScope") && `proposals=${str("proposalScope")}`,
        str("simSize") && `size=${str("simSize")}`,
      ].filter(Boolean) as string[];
      if (scopeBits.length) out.push(["Scope", scopeBits.join(", ")]);
      const council = arr("councilSims");
      if (council.length) out.push(["Council sims", `${council.length} — see below`]);
      break;
    }
    case "proposal": {
      const startDate = str("startDate");
      const endDate = str("endDate");
      if (startDate || endDate) {
        out.push(["Dates", `${startDate || "?"} → ${endDate || "?"}`]);
      }
      const ws = v.workScope as Record<string, unknown> | undefined;
      if (ws && typeof ws === "object") {
        const scope = ws.scope || ws.expression;
        if (typeof scope === "string" && scope.trim()) {
          out.push(["Workscope", scope]);
        }
      }
      const contribs = arr<Record<string, unknown>>("contributors");
      if (contribs.length) {
        const names = contribs
          .map((c) => {
            const ci = c.contributorIdentity;
            if (typeof ci === "string") return ci;
            if (ci && typeof ci === "object" && "uri" in ci) {
              return (ci as { uri: string }).uri;
            }
            return null;
          })
          .filter((x): x is string => !!x);
        out.push([
          "Contributors",
          names.length
            ? `${contribs.length} (${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""})`
            : `${contribs.length}`,
        ]);
      }
      break;
    }
    case "decision": {
      const mech = str("mechanism");
      if (mech) out.push(["Mechanism", mech]);
      const budget = num("budget");
      if (budget !== undefined) out.push(["Budget", `$${budget.toLocaleString()} USD`]);
      const outside = num("outsideOptionKept");
      if (outside !== undefined) out.push(["Outside option kept", `$${outside.toLocaleString()} USD`]);
      const allocs = arr("allocations");
      if (allocs.length) out.push(["Allocations", `${allocs.length} proposal(s)`]);
      const decidedAt = str("decidedAt");
      if (decidedAt) out.push(["Decided at", decidedAt.slice(0, 19)]);
      const gatheringUri = str("gatheringUri");
      if (gatheringUri) out.push(["Gathering", gatheringUri]);
      break;
    }
    case "sim": {
      const spriteKind = str("spriteKind");
      if (spriteKind) out.push(["Sprite kind", spriteKind]);
      const created = str("createdAt");
      if (created) out.push(["Created", created.slice(0, 10)]);
      break;
    }
  }
  return out;
}

/**
 * Per-kind reference blocks — lists of AT-URIs the LLM might want to
 * `simocracy_lookup_record` next (council sims, allocations breakdown,
 * etc.). Returned as titled groups so the formatter can render each
 * block under its own subheading.
 */
function collectKindRefs(
  kind: string,
  v: Record<string, unknown>,
): Array<{ title: string; refs: string[] }> {
  const out: Array<{ title: string; refs: string[] }> = [];
  const arr = <T = unknown>(k: string): T[] =>
    Array.isArray(v[k]) ? (v[k] as T[]) : [];
  if (kind === "gathering") {
    const council = arr<{ uri?: string }>("councilSims");
    if (council.length) {
      out.push({
        title: "Council sims",
        refs: council
          .map((s) => s.uri)
          .filter((u): u is string => !!u),
      });
    }
    const tmpls = arr<{ uri?: string }>("suggestedInterviewTemplates");
    if (tmpls.length) {
      out.push({
        title: "Suggested interview templates",
        refs: tmpls.map((t) => t.uri).filter((u): u is string => !!u),
      });
    }
  }
  if (kind === "decision") {
    const allocs = arr<Record<string, unknown>>("allocations");
    if (allocs.length) {
      out.push({
        title: "Allocations",
        refs: allocs.slice(0, 30).map((a) => {
          const title = (a.proposalTitle as string) || "(untitled)";
          const amount = a.amount as number | undefined;
          const requested = a.requested as number | undefined;
          const uri = (a.proposalUri as string) || "";
          const amt = amount !== undefined ? `$${amount.toLocaleString()}` : "$?";
          const req = requested !== undefined ? ` (requested $${requested.toLocaleString()})` : "";
          return `${amt}${req}  —  ${title}${uri ? `  ${uri}` : ""}`;
        }),
      });
    }
  }
  return out;
}

function formatCommentLine(c: ResolvedComment): string {
  const author = c.simUri
    ? `🐾 ${c.simName} (sim, written by ${c.authorHandle ? `@${c.authorHandle}` : c.did.slice(0, 16) + "…"})`
    : c.authorHandle
      ? `@${c.authorHandle}`
      : c.did.slice(0, 16) + "…";
  const when = (c.createdAt || "").slice(0, 19);
  const head = `- [${when}] ${author}`;
  const body = c.text.length > 240 ? c.text.slice(0, 237) + "…" : c.text;
  // Indent body two spaces under the bullet so it stays visually grouped.
  return `${head}\n  ${body.replace(/\n/g, "\n  ")}`;
}

// ---------------------------------------------------------------------------
// Slash-command flow
// ---------------------------------------------------------------------------

/**
 * `/sim my [name]` — list and load sims owned by the currently
 * signed-in DID. Mirrors the load UX of `/sim <name>` but pre-filtered
 * to the user's own PDS:
 *
 *   - bare `/sim my`     →  if 1 sim: load it. If many: show a select
 *                           picker; on pick, hydrate + render sprite
 *                           inline exactly like `/sim <name>` does.
 *   - `/sim my <name>`   →  fuzzy-match within the user's sims. Exact
 *                           name match loads directly; otherwise the
 *                           ranked candidates go into a select picker.
 *
 * Reads the user's sims from their PDS via `com.atproto.repo.listRecords`
 * (no DPoP needed for reads of the public collection), so this works
 * even if the OAuth session has expired — it only needs the DID, which
 * the auth.json keeps after `lastLogin` is stale.
 */
async function runMySimsCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  arg: string,
): Promise<void> {
  const auth = readAuth();
  if (!auth) {
    ctx.ui.notify(
      "Not signed into ATProto. Run `/sim login <handle>` first (e.g. `/sim login alice.bsky.social`) so /sim my knows which DID's repo to list.",
      "error",
    );
    return;
  }

  ctx.ui.notify(`Listing sims owned by ${auth.handle ? `@${auth.handle}` : auth.did}\u2026`, "info");

  let mySims: SimMatch[];
  try {
    mySims = await fetchSimsForDid(auth.did);
  } catch (err) {
    ctx.ui.notify(
      `Could not list sims from your PDS: ${(err as Error).message}. Is the DID document still resolvable?`,
      "error",
    );
    return;
  }

  if (mySims.length === 0) {
    ctx.ui.notify(
      auth.handle
        ? `@${auth.handle} doesn't own any sims yet. Visit https://simocracy.org/my-sims to create one, then come back and try /sim my again.`
        : `No sims found on this PDS. Create one at https://simocracy.org/my-sims and try again.`,
      "info",
    );
    return;
  }

  // Narrow the candidate pool to fuzzy-matched sims when an arg was
  // supplied; otherwise the full owned list is the candidate pool.
  let candidates: SimMatch[];
  if (arg) {
    const matches = fuzzyMatchOwnedSims(mySims, arg);
    if (matches.length === 0) {
      ctx.ui.notify(
        `No sim matching "${arg}" in your ${mySims.length} sim${mySims.length === 1 ? "" : "s"}. Run /sim my (no args) to see them.`,
        "error",
      );
      return;
    }
    // Exact name match — load straight away, same shortcut /sim <name>
    // takes when the indexer returns one perfect hit.
    if (matches.length === 1 || matches[0].score === 0) {
      await loadAndPostMySim(pi, ctx, matches[0].sim);
      return;
    }
    candidates = matches.map((m) => m.sim);
  } else {
    if (mySims.length === 1) {
      // Only one owned sim — skip the picker, just load it.
      await loadAndPostMySim(pi, ctx, mySims[0]);
      return;
    }
    candidates = mySims;
  }

  // Picker — same shape as /sim <name>'s ambiguous-match prompt so the
  // two flows feel identical. We show created-date as a secondary key
  // since multiple sims can share a name within one repo.
  const labels = candidates.map((s) => {
    const created = (s.sim.createdAt || "").slice(0, 10);
    const tail = created ? `${created}  at://…/${s.rkey}` : `at://…/${s.rkey}`;
    return `${s.sim.name}  —  ${tail}`;
  });
  const title = arg
    ? `Matches for "${arg}" in your ${mySims.length} sim${mySims.length === 1 ? "" : "s"}`
    : `Your sims (${mySims.length})`;
  const picked = await ctx.ui.select(title, labels);
  if (!picked) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }
  const chosen = candidates[labels.indexOf(picked)];
  await loadAndPostMySim(pi, ctx, chosen);
}

async function loadAndPostMySim(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  match: SimMatch,
): Promise<void> {
  ctx.ui.notify(`Loading ${match.sim.name}…`, "info");
  let sim: LoadedSim;
  try {
    sim = await hydrateLoadedSim(match);
  } catch (err) {
    ctx.ui.notify(`Failed to load sim: ${(err as Error).message}`, "error");
    return;
  }
  loadedSim = sim;
  await postSimToChat(pi, ctx, sim, true);
}

/**
 * Score user-owned sims against a query string. Returns matches sorted
 * best-first. Score 0 = exact name match (prompt-suppressing), higher =
 * worse. Mirrors the heuristic the indexer search uses but constrained
 * to the already-fetched list, so this is purely client-side and no
 * extra HTTP calls are issued.
 */
function fuzzyMatchOwnedSims(
  sims: SimMatch[],
  query: string,
): Array<{ sim: SimMatch; score: number }> {
  const q = query.toLowerCase().trim();
  const out: Array<{ sim: SimMatch; score: number }> = [];
  for (const sim of sims) {
    const name = sim.sim.name.toLowerCase().trim();
    let score = Number.POSITIVE_INFINITY;
    if (name === q) score = 0;
    else if (name.replace(/\s+/g, "") === q.replace(/\s+/g, "")) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (name.includes(q)) score = 3 + (name.length - q.length);
    else {
      const tokens = q.split(/\s+/).filter(Boolean);
      const matched = tokens.filter((t) => name.includes(t)).length;
      if (matched > 0) score = 100 - matched;
    }
    if (Number.isFinite(score)) out.push({ sim, score });
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}

async function runLoadFlow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  arg: string,
): Promise<void> {
  // Defense-in-depth: if a reserved subcommand keyword somehow ends up
  // here (e.g. dispatcher regression, exotic input that bypassed the
  // case + zero-width normalization in the `/sim` handler), refuse to
  // search the indexer for it. Otherwise the user sees a misleading
  // `Searching for "login"…` followed by an indexer-fetch error.
  const argTrimmed = arg.trim();
  if (RESERVED_SUBCOMMANDS.has(argTrimmed.toLowerCase())) {
    ctx.ui.notify(
      `\`${argTrimmed}\` is a reserved subcommand. Did you mean \`/sim ${argTrimmed.toLowerCase()}\`? Run \`/sim help\` for the full list.`,
      "error",
    );
    return;
  }
  ctx.ui.notify(`Searching for "${arg}"…`, "info");
  let matches: SimMatch[] = [];
  if (arg.startsWith("at://")) {
    // AT-URI shortcut — fetch directly.
    try {
      const sim = await tryLoadFromQuery(arg);
      if (sim) {
        loadedSim = sim;
        await postSimToChat(pi, ctx, sim, true);
        return;
      }
    } catch {
      /* fall through to search */
    }
  }
  try {
    const result = await loadSimByName(arg);
    matches = result.matches;
    if (result.error) {
      ctx.ui.notify(result.error, "error");
      return;
    }
  } catch (err) {
    ctx.ui.notify(`Search failed: ${(err as Error).message}`, "error");
    return;
  }
  let chosen = matches[0];
  if (matches.length > 1) {
    const labels = matches.map((m) => `${m.sim.name}  —  ${m.uri}`);
    const picked = await ctx.ui.select(`Multiple matches for "${arg}"`, labels);
    if (!picked) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
    chosen = matches[labels.indexOf(picked)];
  }
  ctx.ui.notify(`Loading ${chosen.sim.name}…`, "info");
  let sim: LoadedSim;
  try {
    sim = await hydrateLoadedSim(chosen);
  } catch (err) {
    ctx.ui.notify(`Failed to load sim: ${(err as Error).message}`, "error");
    return;
  }
  loadedSim = sim;
  await postSimToChat(pi, ctx, sim, true);
}

async function tryLoadFromQuery(query: string): Promise<LoadedSim | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("at://")) {
    try {
      const { did, rkey } = parseAtUri(trimmed);
      // Fetch the sim record from the PDS so we have the blob refs.
      const { getRecordFromPds } = await import("./simocracy.ts");
      const sim = await getRecordFromPds<{
        name: string;
        spriteKind?: "pipoya" | "codexPet";
        image?: { ref: unknown; mimeType: string; size: number };
        sprite?: { ref: unknown; mimeType: string; size: number };
        petSheet?: { ref: unknown; mimeType: string; size: number };
        petManifest?: { id?: string; displayName?: string; description?: string };
        $type?: string;
      }>(did, "org.simocracy.sim", rkey);
      const match: SimMatch = {
        uri: trimmed,
        cid: "",
        did,
        rkey,
        sim: {
          $type: "org.simocracy.sim",
          name: sim.name,
          spriteKind: sim.spriteKind,
          settings: { selectedOptions: {} },
          image: sim.image as never,
          sprite: sim.sprite as never,
          petSheet: sim.petSheet as never,
          petManifest: sim.petManifest,
          createdAt: "",
        },
      };
      return await hydrateLoadedSim(match);
    } catch {
      return null;
    }
  }
  const result = await loadSimByName(trimmed);
  if (!result.matches.length) return null;
  return await hydrateLoadedSim(result.matches[0]);
}

/**
 * Shape of `details` on the `simocracy_sim_loaded` custom message.
 * The renderer reads this to choose between the inline-graphics and
 * ANSI-half-block render paths; both fields are best-effort — the
 * renderer falls back to the combined `body` string if anything is
 * missing.
 */
interface SimLoadedDetails {
  uri?: string;
  did?: string;
  rkey?: string;
  name?: string;
  /** Combined ANSI sprite + bio, used by the half-block fallback path
   *  and as the textual log content. */
  body?: string;
  /** Bio text only (no sprite), used alongside the Image component
   *  on the inline-graphics path. */
  bioText?: string;
  /** base64-encoded PNG of the sprite cell. Triggers the inline-graphics
   *  path when set + the terminal advertises image support. */
  spritePngBase64?: string;
  /** Native PNG width in pixels (aspect ratio for Image scaling). */
  spritePngWidth?: number;
  /** Native PNG height in pixels. */
  spritePngHeight?: number;
  /**
   * Identity tag for the active animation, if any. The message renderer
   * compares against `currentAnimation.key` to decide whether to swap
   * in the current animation frame or freeze on the static idle PNG.
   * Stable across re-renders of the same message; differs across
   * separate sim loads.
   */
  animationKey?: string;
}

async function postSimToChat(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sim: LoadedSim,
  _reload: boolean,
) {
  ctx.ui.setStatus("simocracy", `🐾 ${sim.name}`);
  // Use the factory form of setWidget so we can capture pi-tui's TUI
  // handle. We need it to call `requestRender()` from the animation
  // setInterval (the message renderer doesn't get a TUI reference).
  // The factory itself returns a tiny static Text widget — the TUI
  // capture is the actual purpose.
  const headerText = `Simocracy: ${sim.name}${sim.handle ? `  (@${sim.handle})` : ""}`;
  ctx.ui.setWidget(
    "simocracy",
    (tui) => {
      capturedTui = tui;
      return new Text(headerText, 0, 0);
    },
    { placement: "aboveEditor" },
  );
  const body = formatSimSummary(sim, ctx.ui.theme);
  const bioText = formatSimBio(sim, ctx.ui.theme);
  // Unique key per load so the renderer can tell which message owns
  // the active animation. AT-URI + timestamp protects against
  // re-loading the same sim twice (each load starts its own loop).
  const animationKey = `${sim.uri}#${Date.now()}`;
  const details: SimLoadedDetails = {
    uri: sim.uri,
    did: sim.did,
    rkey: sim.rkey,
    name: sim.name,
    body,
    bioText,
    animationKey,
  };
  if (sim.spritePng) {
    details.spritePngBase64 = sim.spritePng.base64;
    details.spritePngWidth = sim.spritePng.widthPx;
    details.spritePngHeight = sim.spritePng.heightPx;
  }
  pi.sendMessage({
    customType: "simocracy_sim_loaded",
    content: stripAnsiForLog(body),
    display: true,
    details,
  });
  // Kick off (or replace) the animation loop. Only one loop runs at a
  // time — the last loaded sim animates, earlier messages freeze on
  // their idle frame.
  if (sim.spriteFrames) {
    startAnimationFor(animationKey, sim.spriteFrames);
  } else {
    stopCurrentAnimation();
  }
}

/** Strip ANSI escapes for the textual log copy (the renderer uses details.body). */
function stripAnsiForLog(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
