/** Tiles kept under this count. sql.js holds the whole database in memory and copies it on export. */
export const HARD_TILE_CAP = 3000;

/** Stop enumerating once the bounding box is this large. The circle filter is stricter, but the scan itself must stay cheap. */
export const ENUM_TILE_LIMIT = 20_000;

export const WARN_TILE_COUNT = 1200;

/** Rough JPEG satellite tile. The UI labels this as an estimate. */
export const ESTIMATED_TILE_BYTES = 30_000;

export const MAX_TILE_BYTES = 1_500_000;

export const DOWNLOAD_CONCURRENCY = 4;

export const DOWNLOAD_RETRIES = 3;

export const MERCATOR_MAX_LAT = 85.05112878;

export const EARTH_RADIUS_M = 6_378_137;
