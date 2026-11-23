import { QGC_PROVIDERS } from './qgctiledb';
import { TILE_SOURCES } from './sources';

export interface Settings {
  sourceId: string;
  customUrl: string;
  customSubdomains: string;
  maptilerKey: string;
  mapboxKey: string;
  lat: number;
  lon: number;
  radiusM: number;
  radiusUnit: 'm' | 'km';
  minZoom: number;
  maxZoom: number;
  alsoZip: boolean;
  zipLayout: 'xyz' | 'mp';
  alsoQgc: boolean;
  qgcProviderId: string;
  qgcNoGoogle: boolean;
  mapName: string;
}

export const DEFAULT_SETTINGS: Settings = {
  sourceId: 'esri',
  customUrl: 'https://server.example/{z}/{x}/{y}.jpg',
  customSubdomains: '',
  maptilerKey: '',
  mapboxKey: '',
  lat: 55.751244,
  lon: 37.618423,
  radiusM: 1500,
  radiusUnit: 'km',
  minZoom: 15,
  maxZoom: 17,
  alsoZip: false,
  zipLayout: 'xyz',
  alsoQgc: true,
  qgcProviderId: 'esri-satellite',
  qgcNoGoogle: false,
  mapName: '',
};

const STORAGE_KEY = 'sputnik-mbtiles-settings-v1';

function num(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function sanitizeSettings(value: unknown): Settings {
  const raw = value && typeof value === 'object' ? (value as Partial<Settings>) : {};
  const sourceId = TILE_SOURCES.some((source) => source.id === raw.sourceId)
    ? String(raw.sourceId)
    : DEFAULT_SETTINGS.sourceId;
  const qgcProviderId = QGC_PROVIDERS.some((provider) => provider.id === raw.qgcProviderId)
    ? String(raw.qgcProviderId)
    : DEFAULT_SETTINGS.qgcProviderId;
  const minZoom = Math.round(num(raw.minZoom, DEFAULT_SETTINGS.minZoom, 0, 20));
  const maxZoom = Math.round(num(raw.maxZoom, DEFAULT_SETTINGS.maxZoom, 0, 20));
  return {
    sourceId,
    customUrl: str(raw.customUrl, DEFAULT_SETTINGS.customUrl),
    customSubdomains: str(raw.customSubdomains, DEFAULT_SETTINGS.customSubdomains),
    maptilerKey: str(raw.maptilerKey, ''),
    mapboxKey: str(raw.mapboxKey, ''),
    lat: num(raw.lat, DEFAULT_SETTINGS.lat, -90, 90),
    lon: num(raw.lon, DEFAULT_SETTINGS.lon, -180, 180),
    radiusM: num(raw.radiusM, DEFAULT_SETTINGS.radiusM, 50, 500_000),
    radiusUnit: raw.radiusUnit === 'm' || raw.radiusUnit === 'km' ? raw.radiusUnit : DEFAULT_SETTINGS.radiusUnit,
    minZoom: Math.min(minZoom, maxZoom),
    maxZoom: Math.max(minZoom, maxZoom),
    alsoZip: Boolean(raw.alsoZip),
    zipLayout: raw.zipLayout === 'mp' ? 'mp' : 'xyz',
    alsoQgc: raw.alsoQgc === undefined ? DEFAULT_SETTINGS.alsoQgc : Boolean(raw.alsoQgc),
    qgcProviderId,
    qgcNoGoogle: Boolean(raw.qgcNoGoogle),
    mapName: str(raw.mapName, ''),
  };
}

export function loadSettings(): Settings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode and full storage are non-fatal: the page still works.
  }
}

export function clearSecretSettings(): Settings {
  const current = loadSettings();
  const next = { ...current, maptilerKey: '', mapboxKey: '' };
  saveSettings(next);
  return next;
}
