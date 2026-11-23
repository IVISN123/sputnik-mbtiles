import { EARTH_RADIUS_M, EXACT_PLAN_LIMIT, MERCATOR_MAX_LAT } from './constants';

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface LngLatBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TilePlan {
  /** Exact tiles. Empty when `approximate` is set, so a huge slider move does not allocate millions of coordinates. */
  tiles: TileCoord[];
  byZoom: Record<number, number>;
  /** Tiles inside the bounding box, before the circle test. */
  bboxCount: number;
  /** Exact length of `tiles`, or a circle-area estimate when `approximate` is set. */
  count: number;
  /**
   * The bounding box was too large to list on the UI thread.
   * `count` is about (π/4) of `bboxCount`. Download still walks the real circle.
   */
  approximate: boolean;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampLat(lat: number): number {
  return clamp(lat, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT);
}

export function normalizeLon(lon: number): number {
  if (!Number.isFinite(lon)) return 0;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** XYZ row → TMS row stored in MBTiles. Symmetric. */
export function xyzToTmsY(y: number, z: number): number {
  return 2 ** z - 1 - y;
}

export function tmsYToXyz(y: number, z: number): number {
  return xyzToTmsY(y, z);
}

export function lonToTileX(lon: number, z: number): number {
  const n = 2 ** z;
  const x = Math.floor(((normalizeLon(lon) + 180) / 360) * n);
  return clamp(x, 0, n - 1);
}

export function latToTileY(lat: number, z: number): number {
  const n = 2 ** z;
  const latClamped = clampLat(lat);
  const latRad = (latClamped * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return clamp(y, 0, n - 1);
}

export function lonLatToTile(lon: number, lat: number, z: number): TileCoord {
  return { z, x: lonToTileX(lon, z), y: latToTileY(lat, z) };
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export function tileBounds(z: number, x: number, y: number): LngLatBounds {
  return {
    west: tileXToLon(x, z),
    east: tileXToLon(x + 1, z),
    north: tileYToLat(y, z),
    south: tileYToLat(y + 1, z),
  };
}

export interface CircleBounds extends LngLatBounds {
  /** West is numerically greater than east: the circle crosses the antimeridian. */
  crossesAntimeridian: boolean;
}

/**
 * Geodesic bounding box of a circle. Longitude half-width uses the spherical
 * formula asin(sin(δ) / cos φ). If the circle reaches a pole, longitude spans
 * the whole world so the later tile scan cannot miss a wrap.
 */
export function circleBounds(lat: number, lon: number, radiusM: number): CircleBounds {
  const safeRadius = Math.max(0, radiusM);
  const δ = safeRadius / EARTH_RADIUS_M;
  const φ = (clamp(lat, -90, 90) * Math.PI) / 180;
  const sinφ = Math.sin(φ);
  const cosφ = Math.cos(φ);
  const north = (Math.asin(clamp(sinφ * Math.cos(δ) + cosφ * Math.sin(δ), -1, 1)) * 180) / Math.PI;
  const south = (Math.asin(clamp(sinφ * Math.cos(δ) - cosφ * Math.sin(δ), -1, 1)) * 180) / Math.PI;
  const reachesPole =
    δ >= Math.PI || Math.abs(cosφ) < 1e-12 || Math.sin(δ) > Math.abs(cosφ) + 1e-15;

  if (reachesPole) {
    return {
      west: -180,
      east: 180,
      north: clampLat(north),
      south: clampLat(south),
      crossesAntimeridian: false,
    };
  }

  const Δλ = Math.asin(clamp(Math.sin(δ) / cosφ, -1, 1));
  const westRaw = lon - (Δλ * 180) / Math.PI;
  const eastRaw = lon + (Δλ * 180) / Math.PI;
  const span = eastRaw - westRaw;
  if (span >= 360) {
    return {
      west: -180,
      east: 180,
      north: clampLat(north),
      south: clampLat(south),
      crossesAntimeridian: false,
    };
  }

  const west = normalizeLon(westRaw);
  const east = normalizeLon(eastRaw);
  const crossesAntimeridian = westRaw < -180 || eastRaw > 180 || west > east;
  return {
    west,
    east,
    north: clampLat(north),
    south: clampLat(south),
    crossesAntimeridian,
  };
}

/** Minimum distance in metres from a point to a longitude/latitude rectangle, in a local equirectangular frame. */
export function pointToBoundsDistanceM(lat: number, lon: number, bounds: LngLatBounds): number {
  if (bounds.west > bounds.east) {
    return Math.min(
      pointToBoundsDistanceM(lat, lon, { ...bounds, east: 180 }),
      pointToBoundsDistanceM(lat, lon, { ...bounds, west: -180 }),
    );
  }

  const midLon = (bounds.west + bounds.east) / 2;
  let lonAdj = lon;
  if (lonAdj - midLon > 180) lonAdj -= 360;
  if (midLon - lonAdj > 180) lonAdj += 360;

  const midLat = (bounds.south + bounds.north) / 2;
  const kx = (Math.PI / 180) * EARTH_RADIUS_M * Math.cos((midLat * Math.PI) / 180);
  const ky = (Math.PI / 180) * EARTH_RADIUS_M;
  const cx = lonAdj * kx;
  const cy = lat * ky;
  const qx = clamp(cx, bounds.west * kx, bounds.east * kx);
  const qy = clamp(cy, bounds.south * ky, bounds.north * ky);
  return Math.hypot(cx - qx, cy - qy);
}

const INTERSECT_TOLERANCE_M = 1;

export function tileIntersectsCircle(
  tile: TileCoord,
  lat: number,
  lon: number,
  radiusM: number,
): boolean {
  const bounds = tileBounds(tile.z, tile.x, tile.y);
  return pointToBoundsDistanceM(lat, lon, bounds) <= radiusM + INTERSECT_TOLERANCE_M;
}

function xRanges(bounds: CircleBounds, z: number): Array<[number, number]> {
  const n = 2 ** z;
  if (!bounds.crossesAntimeridian && bounds.west <= bounds.east) {
    return [[lonToTileX(bounds.west, z), lonToTileX(bounds.east, z)]];
  }
  return [
    [lonToTileX(bounds.west, z), n - 1],
    [0, lonToTileX(bounds.east, z)],
  ];
}

export function bboxTileCount(bounds: CircleBounds, z: number): number {
  const yCount = latToTileY(bounds.south, z) - latToTileY(bounds.north, z) + 1;
  let xCount = 0;
  for (const [x0, x1] of xRanges(bounds, z)) {
    xCount += x1 - x0 + 1;
  }
  return Math.max(0, xCount) * Math.max(0, yCount);
}

function zoomSpan(minZoom: number, maxZoom: number): [number, number] {
  const z0 = Math.max(0, Math.min(minZoom, maxZoom));
  const z1 = Math.max(z0, Math.max(minZoom, maxZoom));
  return [z0, z1];
}

/** Visits every Web Mercator tile whose footprint meets the circle. */
export function forEachCircleTile(
  lat: number,
  lon: number,
  radiusM: number,
  minZoom: number,
  maxZoom: number,
  visit: (tile: TileCoord) => void,
): void {
  const [z0, z1] = zoomSpan(minZoom, maxZoom);
  const bounds = circleBounds(lat, lon, radiusM);
  for (let z = z0; z <= z1; z++) {
    const yMin = latToTileY(bounds.north, z);
    const yMax = latToTileY(bounds.south, z);
    for (const [x0, x1] of xRanges(bounds, z)) {
      for (let x = x0; x <= x1; x++) {
        for (let y = yMin; y <= yMax; y++) {
          const tile = { z, x, y };
          if (tileIntersectsCircle(tile, lat, lon, radiusM)) visit(tile);
        }
      }
    }
  }
}

/** Lazy exact list. Coordinates are produced one at a time, not stored. */
export function* iterateCircleTiles(
  lat: number,
  lon: number,
  radiusM: number,
  minZoom: number,
  maxZoom: number,
): Generator<TileCoord> {
  const [z0, z1] = zoomSpan(minZoom, maxZoom);
  const bounds = circleBounds(lat, lon, radiusM);
  for (let z = z0; z <= z1; z++) {
    const yMin = latToTileY(bounds.north, z);
    const yMax = latToTileY(bounds.south, z);
    for (const [x0, x1] of xRanges(bounds, z)) {
      for (let x = x0; x <= x1; x++) {
        for (let y = yMin; y <= yMax; y++) {
          const tile = { z, x, y };
          if (tileIntersectsCircle(tile, lat, lon, radiusM)) yield tile;
        }
      }
    }
  }
}

const COUNT_YIELD_EVERY = 25_000;

/** Exact count that yields to the UI thread on large scans. */
export async function countCircleTiles(
  lat: number,
  lon: number,
  radiusM: number,
  minZoom: number,
  maxZoom: number,
): Promise<{ count: number; byZoom: Record<number, number> }> {
  const [z0, z1] = zoomSpan(minZoom, maxZoom);
  const bounds = circleBounds(lat, lon, radiusM);
  const byZoom: Record<number, number> = {};
  let count = 0;
  let steps = 0;
  for (let z = z0; z <= z1; z++) {
    const yMin = latToTileY(bounds.north, z);
    const yMax = latToTileY(bounds.south, z);
    let zoomCount = 0;
    for (const [x0, x1] of xRanges(bounds, z)) {
      for (let x = x0; x <= x1; x++) {
        for (let y = yMin; y <= yMax; y++) {
          steps += 1;
          if (tileIntersectsCircle({ z, x, y }, lat, lon, radiusM)) {
            zoomCount += 1;
            count += 1;
          }
          if (steps % COUNT_YIELD_EVERY === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        }
      }
    }
    if (zoomCount > 0) byZoom[z] = zoomCount;
  }
  return { count, byZoom };
}

export function planTiles(
  lat: number,
  lon: number,
  radiusM: number,
  minZoom: number,
  maxZoom: number,
): TilePlan {
  const [z0, z1] = zoomSpan(minZoom, maxZoom);
  const bounds = circleBounds(lat, lon, radiusM);
  let bboxCount = 0;
  const bboxByZoom: Record<number, number> = {};
  for (let z = z0; z <= z1; z++) {
    const count = bboxTileCount(bounds, z);
    if (count > 0) bboxByZoom[z] = count;
    bboxCount += count;
  }

  if (bboxCount > EXACT_PLAN_LIMIT) {
    const byZoom: Record<number, number> = {};
    let count = 0;
    for (const [zoom, boxCount] of Object.entries(bboxByZoom)) {
      const estimate = Math.max(1, Math.round(boxCount * (Math.PI / 4)));
      byZoom[Number(zoom)] = estimate;
      count += estimate;
    }
    return { tiles: [], byZoom, bboxCount, count, approximate: true };
  }

  const tiles: TileCoord[] = [];
  const byZoom: Record<number, number> = {};
  forEachCircleTile(lat, lon, radiusM, z0, z1, (tile) => {
    tiles.push(tile);
    byZoom[tile.z] = (byZoom[tile.z] ?? 0) + 1;
  });
  return { tiles, byZoom, bboxCount, count: tiles.length, approximate: false };
}

/** Axis-aligned union of tile footprints. Antimeridian sets span the long way; callers can substitute the circle box. */
export function unionTileBounds(tiles: TileCoord[]): LngLatBounds | null {
  if (tiles.length === 0) return null;
  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;
  for (const tile of tiles) {
    const bounds = tileBounds(tile.z, tile.x, tile.y);
    west = Math.min(west, bounds.west);
    east = Math.max(east, bounds.east);
    south = Math.min(south, bounds.south);
    north = Math.max(north, bounds.north);
  }
  return { west, south, east, north };
}
