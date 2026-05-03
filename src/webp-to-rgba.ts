/**
 * WebP → RGBA decoder for Node.
 *
 * `pngjs` covers the PNG side of pi-simocracy, but the OpenAI hatch-pet
 * skill (and therefore most `org.simocracy.sim` records with
 * `spriteKind = "codexPet"`) ships its 1536×1872 atlas as WebP. We need
 * a WebP decoder to render the idle frame.
 *
 * @jsquash/webp's `decode()` is browser-shaped: in Node its wasm glue
 * tries to `fetch()` its own `.wasm` URL, which Undici rejects for
 * `file://`. Workaround: read the wasm bytes from disk via
 * `createRequire().resolve()`, compile to a `WebAssembly.Module`, and
 * feed it to the package's documented `init()` escape hatch. Fully ESM,
 * no native bindings.
 *
 * The wasm module is initialised lazily on the first `decodeWebp()`
 * call so loading pi-simocracy stays cheap when no one ever loads a
 * codex pet sim. Subsequent calls reuse the same module.
 */

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import decode, { init as initWebpDecode } from "@jsquash/webp/decode.js";

let wasmInitPromise: Promise<void> | null = null;

async function ensureWasmInit(): Promise<void> {
  if (wasmInitPromise) return wasmInitPromise;
  wasmInitPromise = (async () => {
    const require = createRequire(import.meta.url);
    // @jsquash/webp ships the decoder wasm next to its JS glue; the
    // package only re-exports JS files, so we have to resolve the wasm
    // path manually. Resolving against the JS entry guarantees we hit
    // the same install of the package the bundler/linker picked.
    const decodeJs = require.resolve("@jsquash/webp/decode.js");
    const wasmPath = decodeJs.replace(/decode\.js$/, "codec/dec/webp_dec.wasm");
    const bytes = await readFile(wasmPath);
    const mod = await WebAssembly.compile(bytes);
    await initWebpDecode(mod);
  })().catch((err) => {
    // Reset so the next caller can retry; otherwise a transient FS
    // error would permanently break codex-pet rendering for the session.
    wasmInitPromise = null;
    throw new Error(`Failed to init @jsquash/webp wasm: ${(err as Error).message}`);
  });
  return wasmInitPromise;
}

/**
 * Decode a WebP buffer into the same flat-RGBA shape `decodePng()`
 * returns, so call sites can treat the two interchangeably.
 *
 * Allocates a fresh `Buffer` rather than aliasing `Uint8ClampedArray`
 * so downstream `Buffer`-only helpers (`pixelAt`, `cropRgba`,
 * `boxDownscaleRgba`) keep working without coercion.
 */
export async function decodeWebp(
  buf: Buffer,
): Promise<{ width: number; height: number; data: Buffer }> {
  await ensureWasmInit();
  // jSquash wants an ArrayBuffer view of just the relevant bytes —
  // passing the whole underlying buffer mis-decodes if `buf` is a slice.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const img = await decode(ab as ArrayBuffer);
  return {
    width: img.width,
    height: img.height,
    data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
  };
}
