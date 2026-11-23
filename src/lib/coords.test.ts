import { describe, expect, it } from 'vitest';
import { parseCoordinates } from './coords';

describe('parseCoordinates', () => {
  it('reads a decimal pair with a dot or a Russian comma', () => {
    expect(parseCoordinates('55.7558, 37.6173')).toEqual({ lat: 55.7558, lon: 37.6173 });
    expect(parseCoordinates('55,7558 37,6173')).toEqual({ lat: 55.7558, lon: 37.6173 });
    expect(parseCoordinates('55.7558 37.6173')).toEqual({ lat: 55.7558, lon: 37.6173 });
  });

  it('reads DMS in several written forms', () => {
    const expected = { lat: 55.7558, lon: 37.6173 };
    const samples = [
      `55°45'20.88"N 37°37'02.28"E`,
      `55°45'20.88" N, 37°37'02.28" E`,
      `N55°45'20.88" E37°37'02.28"`,
      `55 45 20.88 N, 37 37 2.28 E`,
    ];
    for (const sample of samples) {
      const parsed = parseCoordinates(sample);
      expect(parsed?.lat).toBeCloseTo(expected.lat, 4);
      expect(parsed?.lon).toBeCloseTo(expected.lon, 4);
    }
  });

  it('swaps a pair only when the first number cannot be a latitude', () => {
    expect(parseCoordinates('137.6173, 55.7558')).toEqual({ lat: 55.7558, lon: 137.6173 });
    expect(parseCoordinates('37.6173, 55.7558')).toEqual({ lat: 37.6173, lon: 55.7558 });
    expect(parseCoordinates('не координаты')).toBeNull();
    expect(parseCoordinates('')).toBeNull();
    expect(parseCoordinates('120, 200')).toBeNull();
  });
});
