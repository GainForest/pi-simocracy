/**
 * Render a PNG buffer as ANSI true-color terminal art using half-block characters.
 *
 * Each terminal cell renders 2 vertical pixels: top half via foreground color,
 * bottom half via background color of the `▀` (upper half block) character.
 *
 * Transparent pixels (alpha < threshold) are emitted as a "default" cell so the
 * terminal background shows through.
 */

import { PNG } from "pngjs";

export interface RenderOptions {
  /** Crop to the non-transparent bounding box first (default: true). */
  cropToContent?: boolean;
  /** Optional padding in pixels around the cropped region. */
  cropPad?: number;
  /** Indent each line by this many spaces (default: 2). */
  indent?: number;
  /** Alpha cutoff for "transparent" (0–255, default: 16). */
  alphaThreshold?: number;
}

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Decode a PNG buffer into a flat RGBA8 byte array + width/height. */
export function decodePng(buf: Buffer): { width: number; height: number; data: Buffer } {
  const png = PNG.sync.read(buf);
  // pngjs always normalises to RGBA8.
  return { width: png.width, height: png.height, data: png.data };
}

function pixelAt(data: Buffer, width: number, x: number, y: number): RGBA {
  const i = (y * width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}

function findBoundingBox(
  data: Buffer,
  width: number,
  height: number,
  alphaThreshold: number,
): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a > alphaThreshold) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) {
    return { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
  }
  return { x0, y0, x1, y1 };
}

/** Render an RGBA region of a buffer to ANSI half-block art. */
export function renderRgbaToAnsi(
  data: Buffer,
  width: number,
  height: number,
  opts: RenderOptions = {},
): string {
  const cropToContent = opts.cropToContent !== false;
  const pad = opts.cropPad ?? 1;
  const indent = " ".repeat(opts.indent ?? 2);
  const alphaThreshold = opts.alphaThreshold ?? 16;

  let x0 = 0,
    y0 = 0,
    x1 = width - 1,
    y1 = height - 1;
  if (cropToContent) {
    const bb = findBoundingBox(data, width, height, alphaThreshold);
    x0 = Math.max(0, bb.x0 - pad);
    y0 = Math.max(0, bb.y0 - pad);
    x1 = Math.min(width - 1, bb.x1 + pad);
    y1 = Math.min(height - 1, bb.y1 + pad);
  }

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;

  // Process two pixel rows per terminal line.
  const lines: string[] = [];
  const RESET = "\x1b[0m";

  for (let row = 0; row < h; row += 2) {
    let line = indent;
    let lastFg: string | null = null;
    let lastBg: string | null = null;
    for (let col = 0; col < w; col++) {
      const top = pixelAt(data, width, x0 + col, y0 + row);
      const bottom =
        row + 1 < h ? pixelAt(data, width, x0 + col, y0 + row + 1) : { r: 0, g: 0, b: 0, a: 0 };
      const topVisible = top.a > alphaThreshold;
      const bottomVisible = bottom.a > alphaThreshold;

      if (!topVisible && !bottomVisible) {
        // Both transparent — terminator + space lets background show through.
        if (lastFg !== null || lastBg !== null) {
          line += RESET;
          lastFg = null;
          lastBg = null;
        }
        line += " ";
        continue;
      }

      if (topVisible && bottomVisible) {
        // Use ▀: fg = top, bg = bottom
        const fg = `\x1b[38;2;${top.r};${top.g};${top.b}m`;
        const bg = `\x1b[48;2;${bottom.r};${bottom.g};${bottom.b}m`;
        if (fg !== lastFg) {
          line += fg;
          lastFg = fg;
        }
        if (bg !== lastBg) {
          line += bg;
          lastBg = bg;
        }
        line += "▀";
      } else if (topVisible && !bottomVisible) {
        // Use ▀ with default bg
        if (lastBg !== null) {
          line += "\x1b[49m";
          lastBg = null;
        }
        const fg = `\x1b[38;2;${top.r};${top.g};${top.b}m`;
        if (fg !== lastFg) {
          line += fg;
          lastFg = fg;
        }
        line += "▀";
      } else {
        // bottomVisible only — use ▄ with default bg
        if (lastBg !== null) {
          line += "\x1b[49m";
          lastBg = null;
        }
        const fg = `\x1b[38;2;${bottom.r};${bottom.g};${bottom.b}m`;
        if (fg !== lastFg) {
          line += fg;
          lastFg = fg;
        }
        line += "▄";
      }
    }
    line += RESET;
    lines.push(line);
  }

  return lines.join("\n");
}

/** Convenience: decode a PNG buffer and render to ANSI art. */
export function pngToAnsi(buf: Buffer, opts: RenderOptions = {}): string {
  const { width, height, data } = decodePng(buf);
  return renderRgbaToAnsi(data, width, height, opts);
}

/** Extract a sub-region of an RGBA buffer (returns a fresh buffer). */
export function cropRgba(
  data: Buffer,
  width: number,
  _height: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Buffer {
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * width + x) * 4;
    const dstStart = row * w * 4;
    data.copy(out, dstStart, srcStart, srcStart + w * 4);
  }
  return out;
}

/**
 * Downscale an RGBA buffer by an integer factor using nearest-neighbour
 * sampling. Designed for pixel-art images that were upscaled with no
 * filtering — sampling the centre pixel of each source block recovers
 * the original art losslessly.
 *
 * Returns the new buffer plus its dimensions. Throws if `factor < 1` or
 * source dimensions aren't divisible by it.
 */
export function downscaleRgbaNearest(
  data: Buffer,
  width: number,
  height: number,
  factor: number,
): { data: Buffer; width: number; height: number } {
  if (factor < 1 || !Number.isInteger(factor)) {
    throw new Error(`downscale factor must be a positive integer, got ${factor}`);
  }
  if (factor === 1) return { data, width, height };
  if (width % factor !== 0 || height % factor !== 0) {
    throw new Error(
      `downscale ${factor}× needs ${width}×${height} divisible by ${factor}`,
    );
  }
  const newW = width / factor;
  const newH = height / factor;
  const out = Buffer.alloc(newW * newH * 4);
  // Sample the centre pixel of each factor×factor block.
  const offset = Math.floor(factor / 2);
  for (let y = 0; y < newH; y++) {
    const srcY = y * factor + offset;
    for (let x = 0; x < newW; x++) {
      const srcX = x * factor + offset;
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = (y * newW + x) * 4;
      out[dstIdx] = data[srcIdx];
      out[dstIdx + 1] = data[srcIdx + 1];
      out[dstIdx + 2] = data[srcIdx + 2];
      out[dstIdx + 3] = data[srcIdx + 3];
    }
  }
  return { data: out, width: newW, height: newH };
}

/**
 * Box-average downscale an RGBA buffer to arbitrary target dimensions.
 *
 * Uses straight area-weighted averaging on premultiplied alpha so partly
 * transparent edge pixels don't bleed black into the result. Designed for
 * non-pixel-art inputs (codex pet idle thumbnails, codex pet sheet cells)
 * where we want a smaller display size at non-integer ratios.
 *
 * If the target equals the source size, returns the input untouched.
 */
export function boxDownscaleRgba(
  data: Buffer,
  width: number,
  height: number,
  targetW: number,
  targetH: number,
): { data: Buffer; width: number; height: number } {
  if (targetW < 1 || targetH < 1) {
    throw new Error(`boxDownscaleRgba target must be ≥1×1, got ${targetW}×${targetH}`);
  }
  if (targetW === width && targetH === height) {
    return { data, width, height };
  }
  const out = Buffer.alloc(targetW * targetH * 4);
  // For each output pixel, average the source rectangle that maps to it.
  // Edge cells are clamped to the source extent.
  for (let oy = 0; oy < targetH; oy++) {
    const sy0 = (oy * height) / targetH;
    const sy1 = ((oy + 1) * height) / targetH;
    const y0 = Math.floor(sy0);
    const y1 = Math.min(height, Math.ceil(sy1));
    for (let ox = 0; ox < targetW; ox++) {
      const sx0 = (ox * width) / targetW;
      const sx1 = ((ox + 1) * width) / targetW;
      const x0 = Math.floor(sx0);
      const x1 = Math.min(width, Math.ceil(sx1));

      // Premultiplied accumulation so transparent pixels don't smear
      // black RGB values into mostly-opaque neighbours.
      let rSum = 0,
        gSum = 0,
        bSum = 0,
        aSum = 0,
        wSum = 0;
      for (let y = y0; y < y1; y++) {
        // Vertical coverage of this source row inside the output cell.
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0);
        if (wy <= 0) continue;
        for (let x = x0; x < x1; x++) {
          const wx = Math.min(x + 1, sx1) - Math.max(x, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (y * width + x) * 4;
          const a = data[i + 3];
          const aw = a * w;
          rSum += data[i] * aw;
          gSum += data[i + 1] * aw;
          bSum += data[i + 2] * aw;
          aSum += aw;
          wSum += w;
        }
      }
      const di = (oy * targetW + ox) * 4;
      if (aSum > 0) {
        out[di] = Math.min(255, Math.round(rSum / aSum));
        out[di + 1] = Math.min(255, Math.round(gSum / aSum));
        out[di + 2] = Math.min(255, Math.round(bSum / aSum));
        out[di + 3] = Math.min(255, Math.round(aSum / wSum));
      } else {
        out[di] = 0;
        out[di + 1] = 0;
        out[di + 2] = 0;
        out[di + 3] = 0;
      }
    }
  }
  return { data: out, width: targetW, height: targetH };
}

/**
 * Detect the integer upscale factor of a pixel-art image by scanning
 * for the largest factor F where every F×F block has uniform colour.
 *
 * For Simocracy avatars this returns 4 (a 32×32 sprite displayed as a
 * 128×128 PNG). For native-resolution images it returns 1. Falls back
 * to 1 if no consistent factor fits.
 *
 * Tests up to maxFactor (default 8) and only checks factors that
 * cleanly divide both dimensions.
 */
export function detectPixelArtScale(
  data: Buffer,
  width: number,
  height: number,
  maxFactor = 8,
): number {
  for (let f = Math.min(maxFactor, width, height); f >= 2; f--) {
    if (width % f !== 0 || height % f !== 0) continue;
    if (isUniformAtFactor(data, width, height, f)) return f;
  }
  return 1;
}

function isUniformAtFactor(
  data: Buffer,
  width: number,
  height: number,
  factor: number,
): boolean {
  for (let by = 0; by < height; by += factor) {
    for (let bx = 0; bx < width; bx += factor) {
      const baseIdx = (by * width + bx) * 4;
      const r = data[baseIdx];
      const g = data[baseIdx + 1];
      const b = data[baseIdx + 2];
      const a = data[baseIdx + 3];
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          if (dx === 0 && dy === 0) continue;
          const idx = ((by + dy) * width + (bx + dx)) * 4;
          if (
            data[idx] !== r ||
            data[idx + 1] !== g ||
            data[idx + 2] !== b ||
            data[idx + 3] !== a
          ) {
            return false;
          }
        }
      }
    }
  }
  return true;
}
