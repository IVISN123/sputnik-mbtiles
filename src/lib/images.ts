import { toArrayBuffer } from './bytes';

export type RasterFormat = 'jpg' | 'png';

export function sniffImageFormat(data: Uint8Array): RasterFormat | 'webp' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return 'png';
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

async function transcodeToJpeg(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(new Blob([toArrayBuffer(bytes)]));
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement('canvas'), {
            width: bitmap.width,
            height: bitmap.height,
          });
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob =
      'convertToBlob' in canvas
        ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 })
        : await new Promise<Blob | null>((resolve) =>
            (canvas as HTMLCanvasElement).toBlob(resolve, 'image/jpeg', 0.86),
          );
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/** Keep JPEG/PNG. Transcode WebP and other browser-decodable images to JPEG so GCS tools can read them. */
export async function ensureRaster(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; format: RasterFormat } | null> {
  const sniffed = sniffImageFormat(bytes);
  if (sniffed === 'jpg' || sniffed === 'png') return { bytes, format: sniffed };
  const jpeg = await transcodeToJpeg(bytes);
  if (!jpeg || sniffImageFormat(jpeg) !== 'jpg') return null;
  return { bytes: jpeg, format: 'jpg' };
}
