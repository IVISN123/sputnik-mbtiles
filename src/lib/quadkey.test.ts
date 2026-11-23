import { describe, expect, it } from 'vitest';
import { quadKeyToXyz, xyzToQuadKey } from './quadkey';

describe('quadkey', () => {
  it('matches the Bing example for tile 3,5 at zoom 3', () => {
    expect(xyzToQuadKey(3, 5, 3)).toBe('213');
    expect(quadKeyToXyz('213')).toEqual({ x: 3, y: 5, z: 3 });
  });

  it('round-trips tiles, including zoom 0', () => {
    expect(xyzToQuadKey(0, 0, 0)).toBe('');
    expect(quadKeyToXyz('')).toEqual({ x: 0, y: 0, z: 0 });
    for (const z of [1, 4, 8, 18]) {
      const samples = [
        { x: 0, y: 0 },
        { x: 2 ** z - 1, y: 2 ** z - 1 },
        { x: Math.floor(2 ** z / 3), y: Math.floor(2 ** z / 5) },
      ];
      for (const sample of samples) {
        const key = xyzToQuadKey(sample.x, sample.y, z);
        expect(key).toHaveLength(z);
        expect(quadKeyToXyz(key)).toEqual({ ...sample, z });
      }
    }
  });

  it('rejects a digit outside 0–3', () => {
    expect(() => quadKeyToXyz('214')).toThrow(/quadkey/);
  });
});
