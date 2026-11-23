import { Zip, ZipPassThrough } from 'fflate';
import type { TileCoord } from './tiles';

export type ZipLayout = 'xyz' | 'mp';

/**
 * `xyz` is `{z}/{x}/{y}.ext` (OSM / XYZ).
 * `mp` is the Mission Planner cache layout `{Provider}/{z}/{y}/{x}.jpg`.
 * The reader in MyImageCache looks up `.jpg` only, and Y is the XYZ row, not TMS.
 *
 * Files are stored uncompressed and pushed one at a time. The caller should not
 * also keep an array of every tile blob.
 */
export class TileZip {
  private readonly chunks: Uint8Array[] = [];
  private readonly zip: Zip;
  private failed: Error | null = null;

  constructor(
    private readonly layout: ZipLayout,
    private readonly extension: string,
  ) {
    this.zip = new Zip((error, data) => {
      if (error) {
        this.failed = error;
        return;
      }
      if (data.length > 0) this.chunks.push(data);
    });
  }

  add(tile: TileCoord, data: Uint8Array): void {
    const path =
      this.layout === 'mp'
        ? `Custom/${tile.z}/${tile.y}/${tile.x}.jpg`
        : `${tile.z}/${tile.x}/${tile.y}.${this.extension}`;
    const entry = new ZipPassThrough(path);
    this.zip.add(entry);
    entry.push(data, true);
    if (this.failed) throw this.failed;
  }

  finish(): Uint8Array {
    this.zip.end();
    if (this.failed) throw this.failed;
    const size = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks.length = 0;
    return out;
  }
}

export function zipTiles(
  tiles: Array<{ tile: TileCoord; data: Uint8Array }>,
  layout: ZipLayout,
  extension: string,
): Uint8Array {
  const zip = new TileZip(layout, extension);
  for (const { tile, data } of tiles) zip.add(tile, data);
  return zip.finish();
}
