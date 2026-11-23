export interface LatLon {
  lat: number;
  lon: number;
}

function parseNum(raw: string): number {
  return Number.parseFloat(raw.replace(',', '.'));
}

function inRange(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/**
 * Accept latitude, longitude. If the first value cannot be a latitude and the
 * second can, the pair is treated as longitude, latitude.
 */
function orderPair(a: number, b: number): LatLon | null {
  if (inRange(a, b)) return { lat: a, lon: b };
  if (Math.abs(a) > 90 && Math.abs(a) <= 180 && Math.abs(b) <= 90 && inRange(b, a)) {
    return { lat: b, lon: a };
  }
  return null;
}

function normalizeDms(input: string): string {
  return input
    .trim()
    .replace(/[′’]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/[º˚]/g, '°');
}

interface DmsPart {
  deg: number;
  min: number;
  sec: number;
  hemi: 'N' | 'S' | 'E' | 'W' | null;
}

function toSigned(part: DmsPart, kind: 'lat' | 'lon'): number | null {
  const abs = Math.abs(part.deg) + part.min / 60 + part.sec / 3600;
  let sign = part.deg < 0 ? -1 : 1;
  if (part.hemi === 'S' || part.hemi === 'W') sign = -1;
  if (part.hemi === 'N' || part.hemi === 'E') sign = 1;
  const value = sign * abs;
  if (kind === 'lat' && part.hemi && part.hemi !== 'N' && part.hemi !== 'S') return null;
  if (kind === 'lon' && part.hemi && part.hemi !== 'E' && part.hemi !== 'W') return null;
  return value;
}

const DMS_PART =
  /([NSEW])?\s*([+-]?\d+(?:[.,]\d+)?)(?:\s*[°d]\s*|\s+)(?:(\d+(?:[.,]\d+)?)(?:\s*['m]\s*|\s+))?(?:(\d+(?:[.,]\d+)?)(?:\s*["s])?)?\s*([NSEW])?/gi;

function parseDms(input: string): LatLon | null {
  const source = normalizeDms(input);
  if (!/[NSEW°'"]/i.test(source)) return null;
  const parts: DmsPart[] = [];
  for (const match of source.matchAll(DMS_PART)) {
    const hemi = ((match[1] || match[5] || '') as string).toUpperCase() as DmsPart['hemi'];
    const deg = parseNum(match[2] ?? '');
    const min = match[3] ? parseNum(match[3]) : 0;
    const sec = match[4] ? parseNum(match[4]) : 0;
    if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) continue;
    if (min < 0 || sec < 0 || min >= 60 || sec >= 60) continue;
    parts.push({ deg, min, sec, hemi: hemi || null });
  }
  if (parts.length < 2) return null;

  const withHemi = parts.filter((part) => part.hemi);
  if (withHemi.length >= 2) {
    const latPart = parts.find((part) => part.hemi === 'N' || part.hemi === 'S');
    const lonPart = parts.find((part) => part.hemi === 'E' || part.hemi === 'W');
    if (!latPart || !lonPart) return null;
    const lat = toSigned(latPart, 'lat');
    const lon = toSigned(lonPart, 'lon');
    if (lat === null || lon === null || !inRange(lat, lon)) return null;
    return { lat, lon };
  }

  const lat = toSigned(parts[0]!, 'lat');
  const lon = toSigned(parts[1]!, 'lon');
  if (lat === null || lon === null) return null;
  return orderPair(lat, lon);
}

function parseDecimal(input: string): LatLon | null {
  const matches = input.match(/[+-]?\d+(?:[.,]\d+)?/g);
  if (!matches || matches.length !== 2) return null;
  return orderPair(parseNum(matches[0]), parseNum(matches[1]));
}

/** Decimal pair (`55.75, 37.61` or `55,75 37,61`) or DMS with hemisphere letters. */
export function parseCoordinates(input: string): LatLon | null {
  const text = input.trim();
  if (!text) return null;
  return parseDms(text) ?? parseDecimal(text);
}
