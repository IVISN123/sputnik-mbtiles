import { describe, expect, it } from 'vitest';
import {
  circleBounds,
  lonLatToTile,
  planTiles,
  pointToBoundsDistanceM,
  tileBounds,
  tileIntersectsCircle,
  tmsYToXyz,
  xyzToTmsY,
} from './tiles';

describe('TMS flip', () => {
  it('inverts XYZ y and is its own inverse', () => {
    expect(xyzToTmsY(0, 3)).toBe(7);
    expect(xyzToTmsY(5, 3)).toBe(2);
    expect(xyzToTmsY(0, 20)).toBe(2 ** 20 - 1);
    for (const z of [0, 1, 5, 12]) {
      for (const y of [0, Math.floor((2 ** z - 1) / 2), 2 ** z - 1]) {
        expect(tmsYToXyz(xyzToTmsY(y, z), z)).toBe(y);
      }
    }
  });
});

describe('circle → tiles', () => {
  const lat = 55.751244;
  const lon = 37.618423;

  it('keeps the tile under the center and drops a tile on the other side of the world', () => {
    const plan = planTiles(lat, lon, 400, 16, 16);
    expect(plan.approximate).toBe(false);
    const center = lonLatToTile(lon, lat, 16);
    expect(plan.tiles).toContainEqual(center);
    expect(plan.tiles.some((tile) => tile.x === 0 && tile.y === 0)).toBe(false);
    expect(plan.tiles.length).toBeGreaterThan(0);
    expect(plan.tiles.length).toBeLessThan(30);
    for (const tile of plan.tiles) {
      expect(tileIntersectsCircle(tile, lat, lon, 400)).toBe(true);
      expect(pointToBoundsDistanceM(lat, lon, tileBounds(tile.z, tile.x, tile.y))).toBeLessThanOrEqual(401);
    }
  });

  it('does not take the whole bounding box — corners outside the circle are left out', () => {
    const plan = planTiles(lat, lon, 2000, 15, 15);
    expect(plan.approximate).toBe(false);
    expect(plan.bboxCount).toBeGreaterThan(plan.tiles.length);
    expect(plan.tiles.length).toBeGreaterThan(4);
  });

  it('covers both sides of the antimeridian without throwing', () => {
    const plan = planTiles(65, 179.8, 80_000, 6, 6);
    expect(plan.approximate).toBe(false);
    const xs = new Set(plan.tiles.map((tile) => tile.x));
    expect(xs.has(63) || xs.has(62)).toBe(true);
    expect(xs.has(0)).toBe(true);
    const bounds = circleBounds(65, 179.8, 80_000);
    expect(bounds.crossesAntimeridian).toBe(true);
  });

  it('estimates a huge area without listing tiles, and still lists jobs past the old 3000 cap', () => {
    const huge = planTiles(lat, lon, 200_000, 16, 18);
    expect(huge.approximate).toBe(true);
    expect(huge.tiles).toEqual([]);
    expect(huge.count).toBeGreaterThan(20_000);
    expect(huge.bboxCount).toBeGreaterThan(huge.count);

    const pastOldCap = planTiles(lat, lon, 12_000, 16, 16);
    expect(pastOldCap.approximate).toBe(false);
    expect(pastOldCap.tiles.length).toBeGreaterThan(3000);
    expect(pastOldCap.count).toBe(pastOldCap.tiles.length);
  });

  it('counts every zoom in range', () => {
    const plan = planTiles(lat, lon, 800, 14, 15);
    expect(Object.keys(plan.byZoom).sort()).toEqual(['14', '15']);
    expect(plan.tiles.length).toBe(Object.values(plan.byZoom).reduce((sum, count) => sum + count, 0));
  });
});
