import type { Database, SqlJsStatic } from 'sql.js';
import type { RasterFormat } from './images';
import type { TileCoord } from './tiles';

/**
 * Map ids from QGroundControl master (UrlFactory provider list), with Google
 * providers compiled in. `MapProvider::_mapIdIndex` starts at 1 and each
 * provider constructed in that list takes the next id.
 * A build with QGC_NO_GOOGLE_MAPS drops the five Google providers, so later ids shift by -5.
 */
export interface QgcProvider {
  id: string;
  /** TileSets.typeStr and the name shown in QGC. */
  name: string;
  mapIdWithGoogle: number;
}

export const QGC_PROVIDERS: QgcProvider[] = [
  { id: 'google-satellite', name: 'Google Satellite', mapIdWithGoogle: 2 },
  { id: 'bing-satellite', name: 'Bing Satellite', mapIdWithGoogle: 7 },
  { id: 'esri-satellite', name: 'Esri World Satellite', mapIdWithGoogle: 16 },
  { id: 'mapbox-satellite', name: 'Mapbox Satellite', mapIdWithGoogle: 21 },
];

export function qgcProviderById(id: string): QgcProvider {
  return QGC_PROVIDERS.find((provider) => provider.id === id) ?? QGC_PROVIDERS[2]!;
}

export function qgcMapId(provider: QgcProvider, noGoogleBuild: boolean): number {
  if (!noGoogleBuild) return provider.mapIdWithGoogle;
  if (provider.mapIdWithGoogle <= 5) {
    throw new Error('В сборке QGC без Google нет этого источника');
  }
  return provider.mapIdWithGoogle - 5;
}

/** Same layout as `UrlFactory::getTileHash`: `%010d%08d%08d%03d` of map id, XYZ x, XYZ y, zoom. */
export function qgcTileHash(mapId: number, x: number, y: number, z: number): string {
  return `${pad(mapId, 10)}${pad(x, 8)}${pad(y, 8)}${pad(z, 3)}`;
}

function pad(value: number, width: number): string {
  const text = Math.trunc(value).toString();
  return text.length >= width ? text : '0'.repeat(width - text.length) + text;
}

export interface QgcDraft {
  name: string;
  provider: QgcProvider;
  noGoogleBuild: boolean;
  north: number;
  west: number;
  south: number;
  east: number;
  minZoom: number;
  maxZoom: number;
}

/**
 * SQLite file QGroundControl imports as `.qgctiledb`.
 * Tile hash uses XYZ y, not TMS. The set is not the default set, so import creates a named set.
 */
const QGC_INSERT_BATCH = 128;

export class QgcTileDbBuilder {
  private readonly mapId: number;
  private count = 0;
  private begun = false;
  private pending = 0;

  private constructor(
    private db: Database | null,
    mapId: number,
  ) {
    this.mapId = mapId;
  }

  static create(SQL: SqlJsStatic, draft: QgcDraft): QgcTileDbBuilder {
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = ON');
    db.run('PRAGMA journal_mode = OFF');
    db.run('PRAGMA synchronous = OFF');
    db.exec(`
      CREATE TABLE Tiles (
        tileID INTEGER PRIMARY KEY NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        format TEXT NOT NULL,
        tile BLOB NULL,
        size INTEGER,
        type INTEGER,
        date INTEGER DEFAULT 0
      );
      CREATE TABLE TileSets (
        setID INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        typeStr TEXT,
        topleftLat REAL DEFAULT 0.0,
        topleftLon REAL DEFAULT 0.0,
        bottomRightLat REAL DEFAULT 0.0,
        bottomRightLon REAL DEFAULT 0.0,
        minZoom INTEGER DEFAULT 3,
        maxZoom INTEGER DEFAULT 3,
        type INTEGER DEFAULT -1,
        numTiles INTEGER DEFAULT 0,
        defaultSet INTEGER DEFAULT 0,
        date INTEGER DEFAULT 0
      );
      CREATE TABLE SetTiles (
        setID INTEGER NOT NULL REFERENCES TileSets(setID) ON DELETE CASCADE,
        tileID INTEGER NOT NULL REFERENCES Tiles(tileID) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_settiles_unique ON SetTiles(tileID, setID);
      CREATE TABLE TilesDownload (
        setID INTEGER NOT NULL REFERENCES TileSets(setID) ON DELETE CASCADE,
        hash TEXT NOT NULL,
        type INTEGER,
        x INTEGER,
        y INTEGER,
        z INTEGER,
        state INTEGER DEFAULT 0
      );
    `);
    db.run('PRAGMA user_version = 1');
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO TileSets(
        name, typeStr, topleftLat, topleftLon, bottomRightLat, bottomRightLon,
        minZoom, maxZoom, type, numTiles, defaultSet, date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        draft.name,
        draft.provider.name,
        draft.north,
        draft.west,
        draft.south,
        draft.east,
        draft.minZoom,
        draft.maxZoom,
        qgcMapId(draft.provider, draft.noGoogleBuild),
        now,
      ],
    );
    return new QgcTileDbBuilder(db, qgcMapId(draft.provider, draft.noGoogleBuild));
  }

  addTile(tile: TileCoord, data: Uint8Array, format: RasterFormat): void {
    const db = this.requireDb();
    if (!this.begun) {
      db.run('BEGIN');
      this.begun = true;
    }
    const hash = qgcTileHash(this.mapId, tile.x, tile.y, tile.z);
    const now = Math.floor(Date.now() / 1000);
    db.run('INSERT INTO Tiles(hash, format, tile, size, type, date) VALUES (?, ?, ?, ?, ?, ?)', [
      hash,
      format,
      data,
      data.byteLength,
      this.mapId,
      now,
    ]);
    db.run('INSERT INTO SetTiles(setID, tileID) VALUES (1, last_insert_rowid())');
    this.count += 1;
    this.pending += 1;
    if (this.pending >= QGC_INSERT_BATCH) {
      db.run('COMMIT');
      this.begun = false;
      this.pending = 0;
    }
  }

  finish(): Uint8Array {
    const db = this.requireDb();
    if (this.count === 0) throw new Error('Нет тайлов для файла QGroundControl');
    db.run('UPDATE TileSets SET numTiles = ? WHERE setID = 1', [this.count]);
    if (this.begun) db.run('COMMIT');
    this.begun = false;
    return db.export();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('База QGroundControl уже закрыта');
    return this.db;
  }
}
