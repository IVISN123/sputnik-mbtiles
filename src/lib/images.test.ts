import { describe, expect, it } from 'vitest';
import { ensureRaster, sniffImageFormat } from './images';

describe('image sniffing', () => {
  it('recognises JPEG, PNG and WebP, and keeps the original raster bytes', async () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0x00);
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const webp = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
    expect(sniffImageFormat(jpeg)).toBe('jpg');
    expect(sniffImageFormat(png)).toBe('png');
    expect(sniffImageFormat(webp)).toBe('webp');
    expect(sniffImageFormat(Uint8Array.of(1, 2, 3))).toBeNull();
    await expect(ensureRaster(jpeg)).resolves.toEqual({ bytes: jpeg, format: 'jpg' });
    await expect(ensureRaster(png)).resolves.toEqual({ bytes: png, format: 'png' });
  });
});
