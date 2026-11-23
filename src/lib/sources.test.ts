import { describe, expect, it } from 'vitest';
import { xyzToQuadKey } from './quadkey';
import { sourceById, buildTileUrl, templateIsUsable } from './sources';
import { xyzToTmsY } from './tiles';

describe('tile URLs', () => {
  const tile = { z: 3, x: 3, y: 5 };

  it('asks Esri for z/y/x', () => {
    const url = buildTileUrl(sourceById('esri'), tile);
    expect(url).toBe(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/5/3',
    );
  });

  it('puts a Bing quadkey in the aerial URL', () => {
    const url = buildTileUrl(sourceById('bing'), tile);
    expect(url).toContain(`/tiles/a${xyzToQuadKey(3, 5, 3)}.jpeg`);
    expect(url).toMatch(/ecn\.t[0-3]\.tiles\.virtualearth\.net/);
  });

  it('substitutes TMS y, subdomains and the key in a custom template', () => {
    const source = sourceById('custom');
    const url = buildTileUrl(source, tile, {
      template: 'https://tiles.example/{s}/{z}/{x}/{-y}.jpg?key={key}',
      subdomains: ['a', 'b'],
      key: 'secret key',
    });
    expect(url).toBe(`https://tiles.example/a/3/3/${xyzToTmsY(5, 3)}.jpg?key=secret%20key`);
    expect(templateIsUsable('https://tiles.example/{z}/{x}/{y}.png')).toBe(true);
    expect(templateIsUsable('http://tiles.example/{z}/{x}/{y}.png')).toBe(false);
    expect(templateIsUsable('https://tiles.example/tile.png')).toBe(false);
  });
});
