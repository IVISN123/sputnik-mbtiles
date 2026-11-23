import type { Database, SqlJsStatic } from 'sql.js';
import type { RasterFormat } from './images';
import { tileBounds, xyzToTmsY, type LngLatBounds, type TileCoord } from './tiles';

export interface MbtilesDraft {
  name: string;
  attribution: string;
  description: string;
  centerLon: number;
  centerLat: number;
}

const INSERT_BATCH = 128;

/**
 * MBTiles 1.1 writer. `tiles.tile_row` is TMS: `(2^z - 1) - xyzY`.
 * Each blob is copied into the sql.js heap on insert and is not retained in JavaScript.
 * Journaling is off so SQLite does not keep a second copy of fresh pages.
 * Call `close()` immediately after `finish()` so the heap copy can be collected.
 */
export class MbtilesBuilder {
  private begun = false;
  private pending = 0;
  private tileCount = 0;
  private jpgCount = 0;
  private pngCount = 0;
  private minZoom = Number.POSITIVE_INFINITY;
  private maxZoom = 0;
  private bounds: LngLatBounds | null = null;

  private constructor(
    private db: Database | null,
    private readonly draft: MbtilesDraft,
  ) {}

  static create(SQL: SqlJsStatic, draft: MbtilesDraft): MbtilesBuilder {
    const db = new SQL.Database();
    db.run('PRAGMA journal_mode = OFF');
    db.run('PRAGMA synchronous = OFF');
    db.exec(`
      CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE UNIQUE INDEX metadata_index ON metadata (name);
      CREATE TABLE tiles (
        zoom_level INTEGER,
        tile_column INTEGER,
        tile_row INTEGER,
        tile_data BLOB
      );
      CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
    `);
    return new MbtilesBuilder(db, draft);
  }

  addTile(tile: TileCoord, data: Uint8Array, format: RasterFormat): void {
    const db = this.requireDb();
    if (!this.begun) {
      db.run('BEGIN');
      this.begun = true;
    }
    const tileRow = xyzToTmsY(tile.y, tile.z);
    db.run('INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)', [
      tile.z,
      tile.x,
      tileRow,
      data,
    ]);
    this.note(tile, format);
    this.pending += 1;
    if (this.pending >= INSERT_BATCH) this.commitBatch();
  }

  get count(): number {
    return this.tileCount;
  }

  get format(): RasterFormat {
    return this.pngCount > this.jpgCount ? 'png' : 'jpg';
  }

  finish(): { bytes: Uint8Array; format: RasterFormat; bounds: LngLatBounds; minZoom: number; maxZoom: number } {
    const db = this.requireDb();
    if (this.tileCount === 0 || !this.bounds) {
      throw new Error('Нет ни одного тайла — файл MBTiles не создан');
    }
    const minZoom = this.minZoom;
    const maxZoom = this.maxZoom;
    const bounds = this.bounds;
    const format = this.format;
    const centerZoom = Math.round((minZoom + maxZoom) / 2);
    const metadata: Array<[string, string]> = [
      ['name', this.draft.name],
      ['format', format],
      ['bounds', formatBounds(bounds)],
      ['center', `${round6(this.draft.centerLon)},${round6(this.draft.centerLat)},${centerZoom}`],
      ['minzoom', String(minZoom)],
      ['maxzoom', String(maxZoom)],
      ['type', 'baselayer'],
      ['attribution', this.draft.attribution],
      ['description', this.draft.description],
      ['version', '1.1'],
      ['scheme', 'tms'],
      ['generator', 'sputnik-mbtiles'],
    ];
    for (const [name, value] of metadata) {
      db.run('INSERT INTO metadata (name, value) VALUES (?, ?)', [name, value]);
    }
    if (this.begun) db.run('COMMIT');
    this.begun = false;
    return { bytes: db.export(), format, bounds, minZoom, maxZoom };
  }

  /**
   * One tile at a time, copied out of the wasm heap before the next row.
   * Callers must not accumulate the buffers if they want a single copy of the imagery.
   */
  eachTile(visit: (tile: TileCoord, data: Uint8Array) => void): void {
    const db = this.requireDb();
    const stmt = db.prepare('SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles');
    while (stmt.step()) {
      const row = stmt.get();
      const z = Number(row[0]);
      const x = Number(row[1]);
      const tmsY = Number(row[2]);
      const data = toBytes(row[3]).slice();
      visit({ z, x, y: xyzToTmsY(tmsY, z) }, data);
    }
    stmt.free();
  }

  private note(tile: TileCoord, format: RasterFormat): void {
    this.tileCount += 1;
    if (format === 'png') this.pngCount += 1;
    else this.jpgCount += 1;
    this.minZoom = Math.min(this.minZoom, tile.z);
    this.maxZoom = Math.max(this.maxZoom, tile.z);
    const footprint = tileBounds(tile.z, tile.x, tile.y);
    if (!this.bounds) {
      this.bounds = footprint;
      return;
    }
    this.bounds = {
      west: Math.min(this.bounds.west, footprint.west),
      south: Math.min(this.bounds.south, footprint.south),
      east: Math.max(this.bounds.east, footprint.east),
      north: Math.max(this.bounds.north, footprint.north),
    };
  }

  private commitBatch(): void {
    if (!this.begun) return;
    this.requireDb().run('COMMIT');
    this.begun = false;
    this.pending = 0;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('База MBTiles уже закрыта');
    return this.db;
  }
}

export function formatBounds(bounds: LngLatBounds): string {
  return [bounds.west, bounds.south, bounds.east, bounds.north].map(round6).join(',');
}

function round6(value: number): string {
  return value.toFixed(6);
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('tile_data не является блобом');
}

export { tileBounds };
