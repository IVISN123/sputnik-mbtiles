import { describe, expect, it } from 'vitest';
import { backoffMs, shouldRetry } from './download';

describe('download policy', () => {
  it('backs off exponentially', () => {
    expect(backoffMs(0)).toBe(400);
    expect(backoffMs(1)).toBe(800);
    expect(backoffMs(2)).toBe(1600);
  });

  it('retries transport errors and refusals that may clear, not missing tiles', () => {
    expect(shouldRetry(null, 0)).toBe(true);
    expect(shouldRetry(429, 1)).toBe(true);
    expect(shouldRetry(503, 2)).toBe(true);
    expect(shouldRetry(503, 3)).toBe(false);
    expect(shouldRetry(404, 0)).toBe(false);
    expect(shouldRetry(403, 0)).toBe(false);
    expect(shouldRetry(400, 0)).toBe(false);
  });
});
