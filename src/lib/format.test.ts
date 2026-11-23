import { describe, expect, it } from 'vitest';
import { tileNoun } from './format';

describe('tileNoun', () => {
  it('follows Russian plural rules', () => {
    expect(tileNoun(1)).toBe('тайл');
    expect(tileNoun(2)).toBe('тайла');
    expect(tileNoun(4)).toBe('тайла');
    expect(tileNoun(5)).toBe('тайлов');
    expect(tileNoun(11)).toBe('тайлов');
    expect(tileNoun(21)).toBe('тайл');
    expect(tileNoun(22)).toBe('тайла');
    expect(tileNoun(4523)).toBe('тайла');
  });
});