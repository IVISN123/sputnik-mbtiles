import { unzipSync } from 'fflate';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MbtilesBuilder } from './mbtiles';
import { qgcTileHash, QgcTileDbBuilder, qgcMapId, qgcProviderById } from './qgctiledb';
import { loadSqlNode } from './sql-node';
import { tileBounds, xyzToTmsY } from './tiles';
import { zipTiles } from './zipxyz';

const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00);

function rows(db: import('sql.js').Database, sql: string): unknown[][] {
  const stmt = db.prepare(sql);
  const out: unknown[][] = [];
  while (stmt.step()) out.push(stmt.get());
  stmt.free();
  return out;
}

describe('MBTiles writer', () => {
  it('writes metadata, TMS rows and a unique tile index', async () => {
    const SQL = await loadSqlNode();
    const builder = MbtilesBuilder.create(SQL, {
      name: 'Проверка',
      attribution: 'Esri',
      description: 'тест',
      centerLon: 37.618423,
      centerLat: 55.751244,
    });
    const tile = { z: 3, x: 3, y: 5 };
    builder.addTile(tile, JPEG, 'jpg');
    builder.addTile({ z: 4, x: 1, y: 2 }, PNG, 'png');
    expect(() => builder.addTile(tile, JPEG, 'jpg')).toThrow();

    const built = builder.finish();
    writeFileSync('/tmp/sputnik-sample.mbtiles', built.bytes);
    builder.close();

    const db = new SQL.Database(built.bytes);
    const meta = Object.fromEntries(rows(db, 'SELECT name, value FROM metadata').map((row) => [row[0], row[1]]));
    expect(meta.name).toBe('Проверка');
    expect(meta.format).toBe('jpg');
    expect(meta.type).toBe('baselayer');
    expect(meta.scheme).toBe('tms');
    expect(meta.version).toBe('1.1');
    expect(meta.attribution).toBe('Esri');
    expect(meta.minzoom).toBe('3');
    expect(meta.maxzoom).toBe('4');
    expect(meta.center).toBe('37.618423,55.751244,4');

    const bounds = tileBounds(3, 3, 5);
    const other = tileBounds(4, 1, 2);
    expect(meta.bounds).toBe(
      [Math.min(bounds.west, other.west), Math.min(bounds.south, other.south), Math.max(bounds.east, other.east), Math.max(bounds.north, other.north)]
        .map((value) => value.toFixed(6))
        .join(','),
    );

    const stored = rows(db, 'SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles ORDER BY zoom_level');
    expect(stored[0]?.[0]).toBe(3);
    expect(stored[0]?.[1]).toBe(3);
    expect(stored[0]?.[2]).toBe(xyzToTmsY(5, 3));
    expect(stored[0]?.[2]).not.toBe(5);
    expect(Buffer.from(stored[0]?.[3] as Uint8Array)).toEqual(Buffer.from(JPEG));

    const indexes = rows(db, "SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row[0]);
    expect(indexes).toContain('tile_index');
    db.close();
  });
});

describe('QGroundControl tile database', () => {
  it('hashes XYZ y (not TMS) and links the tile to a named set', async () => {
    const SQL = await loadSqlNode();
    const provider = qgcProviderById('esri-satellite');
    expect(qgcTileHash(16, 3, 5, 3)).toBe('00000000160000000300000005003');
    expect(qgcMapId(provider, false)).toBe(16);
    expect(qgcMapId(provider, true)).toBe(11);

    const builder = QgcTileDbBuilder.create(SQL, {
      name: 'Поле',
      provider,
      noGoogleBuild: false,
      north: 56,
      west: 37,
      south: 55,
      east: 38,
      minZoom: 3,
      maxZoom: 3,
    });
    builder.addTile({ z: 3, x: 3, y: 5 }, JPEG, 'jpg');
    const bytes = builder.finish();
    writeFileSync('/tmp/sputnik-sample.qgctiledb', bytes);
    builder.close();

    const db = new SQL.Database(bytes);
    const version = rows(db, 'PRAGMA user_version');
    expect(version[0]?.[0]).toBe(1);
    const tile = rows(db, 'SELECT hash, format, type, size FROM Tiles')[0];
    expect(tile?.[0]).toBe(qgcTileHash(16, 3, 5, 3));
    expect(tile?.[0]).not.toBe(qgcTileHash(16, 3, xyzToTmsY(5, 3), 3));
    expect(tile?.[1]).toBe('jpg');
    expect(tile?.[2]).toBe(16);
    const set = rows(db, 'SELECT name, typeStr, defaultSet, numTiles, type FROM TileSets')[0];
    expect(set).toEqual(['Поле', 'Esri World Satellite', 0, 1, 16]);
    const link = rows(db, 'SELECT setID, tileID FROM SetTiles');
    expect(link).toEqual([[1, 1]]);
    db.close();
  });
});

describe('XYZ zip', () => {
  it('stores OSM order and the Mission Planner Custom/z/y/x.jpg layout', () => {
    const tiles = [{ tile: { z: 3, x: 3, y: 5 }, data: JPEG }];
    const xyz = unzipSync(zipTiles(tiles, 'xyz', 'jpg'));
    expect(Object.keys(xyz)).toEqual(['3/3/5.jpg']);
    const mp = unzipSync(zipTiles(tiles, 'mp', 'png'));
    expect(Object.keys(mp)).toEqual(['Custom/3/5/3.jpg']);
    expect(mp['Custom/3/5/3.jpg']).toEqual(JPEG);
  });
});
