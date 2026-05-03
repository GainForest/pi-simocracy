/**
 * Encode an RGBA pixel buffer to a PNG (`Buffer`) for inline terminal
 * graphics protocols (Kitty, iTerm2). Both protocols accept base64-PNG
 * payloads — Kitty supports it via `f=100`, iTerm2 via `inline=1`.
 *
 * Sized to be tiny: the only operation here is wrapping `pngjs`'s
 * synchronous packer in a typed helper that matches the
 * decoder/cropper interfaces in `png-to-ansi.ts`. We never need
 * streaming or async — the largest image we encode is a 192×208 codex
 * pet idle cell (~30 KB PNG).
 */

import { PNG } from "pngjs";

/**
 * Encode a flat RGBA8 buffer to PNG. `data.length` must equal
 * `width * height * 4`. Returns a fresh `Buffer` containing the PNG
 * bytes (signature `89 50 4e 47 …`).
 */
export function encodeRgbaToPng(data: Buffer, width: number, height: number): Buffer {
  if (data.length !== width * height * 4) {
    throw new Error(
      `encodeRgbaToPng: expected ${width * height * 4} bytes for ${width}×${height}, got ${data.length}`,
    );
  }
  const png = new PNG({ width, height });
  data.copy(png.data);
  return PNG.sync.write(png);
}
