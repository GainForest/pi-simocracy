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
