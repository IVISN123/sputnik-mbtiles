import type { Database, SqlJsStatic } from 'sql.js';
import type { RasterFormat } from './images';
import { tileBounds, unionTileBounds, xyzToTmsY, type LngLatBounds, type TileCoord } from './tiles';

export interface MbtilesDraft {
  name: string;
  attribution: string;
  description: string;
  centerLon: number;
  centerLat: number;
}

interface StoredTile {
  z: number;
  x: number;
  y: number;
  format: RasterFormat;
}

/**
 * MBTiles 1.1 writer. `tiles.tile_row` is TMS: `(2^z - 1) - xyzY`.
 * The database lives in the sql.js heap; call `close()` after `export()` so the copy can be collected.
 */
export class MbtilesBuilder {
  private readonly tiles: StoredTile[] = [];
  private begun = false;

  private constructor(
    private db: Database | null,
    private readonly draft: MbtilesDraft,
  ) {}

  static create(SQL: SqlJsStatic, draft: MbtilesDraft): MbtilesBuilder {
    const db = new SQL.Database();
    db.run('PRAGMA journal_mode = MEMORY');
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
    this.tiles.push({ z: tile.z, x: tile.x, y: tile.y, format });
  }

  get count(): number {
    return this.tiles.length;
  }

  finish(): { bytes: Uint8Array; format: RasterFormat; bounds: LngLatBounds; minZoom: number; maxZoom: number } {
    const db = this.requireDb();
    if (this.tiles.length === 0) {
      throw new Error('Нет ни одного тайла — файл MBTiles не создан');
    }
    const zooms = this.tiles.map((tile) => tile.z);
    const minZoom = Math.min(...zooms);
    const maxZoom = Math.max(...zooms);
    const bounds = unionTileBounds(this.tiles);
    if (!bounds) throw new Error('Не удалось посчитать границы тайлов');
    const format = majorityFormat(this.tiles);
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

  /** Read tiles back out (XYZ y) for the optional ZIP. Call before `close()`. */
  eachTile(visit: (tile: TileCoord, data: Uint8Array) => void): void {
    const db = this.requireDb();
    const stmt = db.prepare('SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles');
    while (stmt.step()) {
      const row = stmt.get();
      const z = Number(row[0]);
      const x = Number(row[1]);
      const tmsY = Number(row[2]);
      const data = toBytes(row[3]);
      visit({ z, x, y: xyzToTmsY(tmsY, z) }, data);
    }
    stmt.free();
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

function majorityFormat(tiles: StoredTile[]): RasterFormat {
  let jpg = 0;
  let png = 0;
  for (const tile of tiles) {
    if (tile.format === 'png') png += 1;
    else jpg += 1;
  }
  return png > jpg ? 'png' : 'jpg';
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
