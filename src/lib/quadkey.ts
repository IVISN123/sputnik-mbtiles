/** Bing Maps quadkey. Digit bits stay exact past 31 bits of zoom (we never need that, but the shifts do not overflow). */
export function xyzToQuadKey(x: number, y: number, z: number): string {
  if (z < 0 || !Number.isInteger(z)) {
    throw new Error('Масштаб quadkey должен быть целым неотрицательным числом');
  }
  if (z === 0) return '';
  let key = '';
  for (let i = z; i > 0; i--) {
    const mask = 2 ** (i - 1);
    let digit = 0;
    if (Math.floor(x / mask) % 2 !== 0) digit += 1;
    if (Math.floor(y / mask) % 2 !== 0) digit += 2;
    key += digit;
  }
  return key;
}

export function quadKeyToXyz(quadkey: string): { x: number; y: number; z: number } {
  let x = 0;
  let y = 0;
  const z = quadkey.length;
  for (let i = 0; i < z; i++) {
    const digit = quadkey.charCodeAt(i) - 48;
    if (digit < 0 || digit > 3) {
      throw new Error(`Недопустимая цифра quadkey: ${quadkey[i] ?? ''}`);
    }
    const mask = 2 ** (z - i - 1);
    if (digit & 1) x += mask;
    if (digit & 2) y += mask;
  }
  return { x, y, z };
}
