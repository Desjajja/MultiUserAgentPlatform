/**
 * Inbound image normalization.
 *
 * Big phone-camera photos (4-8 MB JPEG, 4032x3024) cost the LLM a lot of
 * tokens for no real benefit on barcode / receipt / shelf-photo workloads.
 * Re-encode at 1280 px max edge and JPEG quality 75 before the bytes hit
 * inbox/ — typical receipts shrink to 80-200 KB while staying clearly
 * readable for downstream OCR / barcode recognition.
 *
 * Lazy-imports sharp the first time we need it. sharp ships native libvips
 * bindings; we don't want require() at module-load to crash the host
 * if a deployment somehow forgot to install it.
 */
import { log } from '../../log.js';

const MAX_EDGE_PX = 1280;
const JPEG_QUALITY = 75;

// sharp's typings export the namespace via its default; the runtime ESM
// shim can present as either a callable or an object with `default`.
// We coerce both to a `(input) => Sharp` signature.
type SharpFactory = (input?: Buffer | string, opts?: { failOn?: 'none' | 'truncated' | 'error' | 'warning' }) => {
  rotate(): ReturnType<SharpFactory>;
  metadata(): Promise<{ width?: number; height?: number }>;
  resize(opts: { width?: number; height?: number; fit?: 'inside' }): ReturnType<SharpFactory>;
  jpeg(opts: { quality?: number; mozjpeg?: boolean }): ReturnType<SharpFactory>;
  toBuffer(): Promise<Buffer>;
};

let cachedSharp: SharpFactory | null = null;
let sharpUnavailable = false;

async function loadSharp(): Promise<SharpFactory | null> {
  if (cachedSharp) return cachedSharp;
  if (sharpUnavailable) return null;
  try {
    const mod = (await import('sharp')) as unknown as Record<string, unknown>;
    // sharp ships as both ESM (mod.default) and CJS (mod itself is the factory).
    const candidate = (typeof mod === 'function' ? mod : (mod as { default?: unknown }).default) as
      | SharpFactory
      | undefined;
    if (typeof candidate !== 'function') throw new Error('sharp module did not expose a factory');
    cachedSharp = candidate;
    return cachedSharp;
  } catch (err) {
    sharpUnavailable = true;
    log.warn('sharp unavailable; inbound images will be passed through uncompressed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Compress a JPEG/PNG/WebP image. Returns the new bytes + final MIME, or
 * `null` to signal "leave the original alone" (sharp missing or input
 * format unsupported). Callers fall back to the raw bytes on null.
 *
 * Always re-encodes to JPEG so the receiving OpenAI / Claude API gets a
 * single mime type regardless of source.
 */
export async function compressInboundImage(
  bytes: Buffer,
  sourceMime: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const mime = (sourceMime || '').split(';')[0].trim().toLowerCase();
  // Skip anything that isn't a still raster we can re-encode safely.
  if (!/^image\/(jpeg|jpg|png|webp|gif|bmp|heic|heif)$/.test(mime)) return null;

  const sharp = await loadSharp();
  if (!sharp) return null;

  try {
    const pipeline = sharp(bytes, { failOn: 'none' }).rotate(); // honor EXIF orientation
    const metadata = await pipeline.metadata();
    const longestEdge = Math.max(metadata.width || 0, metadata.height || 0);
    // Only resize if the source is larger than the cap; smaller images
    // skip the resize pass to avoid upscaling artifacts on tiny stickers.
    const finalPipeline = longestEdge > MAX_EDGE_PX ? pipeline.resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: 'inside' }) : pipeline;
    const out = await finalPipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
    return { bytes: out, mimeType: 'image/jpeg' };
  } catch (err) {
    log.warn('compressInboundImage failed; using original bytes', {
      err: err instanceof Error ? err.message : String(err),
      sourceMime,
      sourceBytes: bytes.length,
    });
    return null;
  }
}
