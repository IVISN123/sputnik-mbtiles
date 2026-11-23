import { zipSync } from 'fflate';
import type { TileCoord } from './tiles';

export type ZipLayout = 'xyz' | 'mp';

/**
 * `xyz` is `{z}/{x}/{y}.ext` (OSM / XYZ).
 * `mp` is the Mission Planner cache layout `{Provider}/{z}/{y}/{x}.jpg`.
 * The reader in MyImageCache looks up `.jpg` only, and Y is the XYZ row, not TMS.
 */
export function zipTiles(
  tiles: Array<{ tile: TileCoord; data: Uint8Array }>,
  layout: ZipLayout,
  extension: string,
): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const { tile, data } of tiles) {
    const path =
      layout === 'mp'
        ? `Custom/${tile.z}/${tile.y}/${tile.x}.jpg`
        : `${tile.z}/${tile.x}/${tile.y}.${extension}`;
    files[path] = data;
  }
  return zipSync(files, { level: 0 });
}
