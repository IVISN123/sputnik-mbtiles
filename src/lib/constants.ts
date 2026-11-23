/**
 * Above this many tiles in the circle's bounding box, the live estimate uses the
 * circle-to-box area ratio instead of listing every tile. The download still
 * walks the real circle and is not blocked.
 */
export const EXACT_PLAN_LIMIT = 50_000;

/** Informational only. A larger job still downloads. */
export const LARGE_TILE_COUNT = 20_000;

/** Informational only, paired with {@link LARGE_TILE_COUNT}. */
export const LARGE_BYTE_ESTIMATE = 1024 * 1024 * 1024;

/** Rough JPEG satellite tile. The UI labels this as an estimate. */
export const ESTIMATED_TILE_BYTES = 30_000;

export const MAX_TILE_BYTES = 1_500_000;

export const DOWNLOAD_CONCURRENCY = 4;

export const DOWNLOAD_RETRIES = 3;

export const MERCATOR_MAX_LAT = 85.05112878;

export const EARTH_RADIUS_M = 6_378_137;
