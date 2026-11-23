export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 Б';
  if (bytes < 1024) return `${Math.round(bytes)} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} МБ`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('ru-RU');
}

/** Russian noun for a tile count: 1 тайл, 2 тайла, 5 тайлов. */
export function tileNoun(count: number): string {
  const abs = Math.abs(Math.round(count)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 'тайлов';
  if (last === 1) return 'тайл';
  if (last >= 2 && last <= 4) return 'тайла';
  return 'тайлов';
}

export function fileBasename(lat: number, lon: number, radiusM: number, minZoom: number, maxZoom: number): string {
  const radius =
    radiusM >= 1000
      ? `${(radiusM / 1000).toFixed(radiusM >= 10_000 ? 0 : 1)}km`
      : `${Math.round(radiusM)}m`;
  const num = (value: number) => value.toFixed(4).replace('-', 'm');
  return `sputnik_${num(lat)}_${num(lon)}_r${radius}_z${minZoom}-${maxZoom}`;
}

export function defaultMapName(lat: number, lon: number, radiusM: number): string {
  const radius =
    radiusM >= 1000 ? `${(radiusM / 1000).toFixed(radiusM >= 10_000 ? 0 : 1)} км` : `${Math.round(radiusM)} м`;
  return `Спутник ${lat.toFixed(4)}, ${lon.toFixed(4)}, ${radius}`;
}
