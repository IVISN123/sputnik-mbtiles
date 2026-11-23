import { DOWNLOAD_RETRIES } from './constants';
import { ensureRaster, type RasterFormat } from './images';
import type { TileCoord } from './tiles';

export function backoffMs(attempt: number): number {
  return 400 * 2 ** attempt;
}

/** Retry transport failures and rate limits. A missing tile or a refusal is final. */
export function shouldRetry(status: number | null, attempt: number, maxAttempts = DOWNLOAD_RETRIES): boolean {
  if (attempt >= maxAttempts) return false;
  if (status === null) return true;
  return status === 408 || status === 429 || status >= 500;
}

export class DownloadCancelled extends Error {
  constructor() {
    super('Отменено');
    this.name = 'DownloadCancelled';
  }
}

export class TileFetchError extends Error {
  readonly network: boolean;

  constructor(message: string, network: boolean) {
    super(message);
    this.name = 'TileFetchError';
    this.network = network;
  }
}

export interface TileFailure {
  tile: TileCoord;
  url: string;
  reason: string;
}

export interface DownloadProgress {
  total: number;
  completed: number;
  failed: number;
  bytes: number;
  inFlight: number;
}

export interface DownloadControl {
  checkpoint: () => Promise<void>;
  isCancelled: () => boolean;
  signal: AbortSignal;
}

export class PauseController implements DownloadControl {
  readonly signal: AbortSignal;
  private readonly abort = new AbortController();
  private paused = false;
  private waiters: Array<() => void> = [];

  constructor() {
    this.signal = this.abort.signal;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) resolve();
  }

  cancel(): void {
    this.abort.abort();
    this.resume();
  }

  isCancelled(): boolean {
    return this.signal.aborted;
  }

  async checkpoint(): Promise<void> {
    if (this.signal.aborted) throw new DownloadCancelled();
    if (this.paused) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    if (this.signal.aborted) throw new DownloadCancelled();
  }
}

export interface DownloadResult {
  completed: number;
  failed: TileFailure[];
  bytes: number;
  cancelled: boolean;
  corsBlocked: boolean;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DownloadCancelled();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DownloadCancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function probeTileUrl(url: string, signal?: AbortSignal): Promise<{
  ok: boolean;
  cors: boolean;
  status: number | null;
  message: string;
}> {
  try {
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        cors: false,
        status: response.status,
        message:
          response.status === 403 || response.status === 401
            ? `Сервер отказал (HTTP ${response.status}). Проверьте ключ и условия доступа.`
            : `Пробный тайл ответил HTTP ${response.status}.`,
      };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const raster = await ensureRaster(bytes);
    if (!raster) {
      return {
        ok: false,
        cors: false,
        status: response.status,
        message: 'Ответ скачался, но это не изображение JPEG, PNG или WebP.',
      };
    }
    return { ok: true, cors: false, status: response.status, message: 'Браузер может скачать тайлы этого источника.' };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return { ok: false, cors: false, status: null, message: 'Проверка отменена.' };
    }
    const detail = error instanceof Error ? error.message : '';
    return { ok: false, cors: true, status: null, message: corsExplanation(detail) };
  }
}

export function corsExplanation(detail = ''): string {
  const extra = detail ? ` (${detail})` : '';
  return `Браузер не дал прочитать тайлы${extra}. Обычно это CORS: карта показывает снимок через тег img, а скрипту тело ответа недоступно. Сторонний прокси не подставляется. Выберите источник, который разрешает чтение (часто это Esri), или укажите свой HTTPS-шаблон.`;
}

export async function downloadTiles(options: {
  tiles: TileCoord[];
  urlFor: (tile: TileCoord) => string;
  onTile: (tile: TileCoord, bytes: Uint8Array, format: RasterFormat) => void;
  control: DownloadControl;
  concurrency: number;
  maxTileBytes: number;
  onProgress: (progress: DownloadProgress) => void;
}): Promise<DownloadResult> {
  const { tiles, urlFor, onTile, control, concurrency, maxTileBytes, onProgress } = options;
  const failures: TileFailure[] = [];
  let completed = 0;
  let bytes = 0;
  let inFlight = 0;
  let cursor = 0;
  let consecutiveNetwork = 0;
  let corsBlocked = false;
  let stop = false;

  const report = () => {
    onProgress({ total: tiles.length, completed, failed: failures.length, bytes, inFlight });
  };

  const worker = async () => {
    while (!stop && cursor < tiles.length) {
      try {
        await control.checkpoint();
      } catch (error) {
        if (error instanceof DownloadCancelled) return;
        throw error;
      }
      const index = cursor;
      cursor += 1;
      const tile = tiles[index];
      if (!tile || stop) return;
      const url = urlFor(tile);
      inFlight += 1;
      report();
      try {
        const raster = await fetchWithRetry(url, control.signal, maxTileBytes);
        if (control.isCancelled() || stop) return;
        onTile(tile, raster.bytes, raster.format);
        completed += 1;
        bytes += raster.bytes.byteLength;
        consecutiveNetwork = 0;
      } catch (error) {
        if (error instanceof DownloadCancelled || control.isCancelled()) return;
        if (!(error instanceof TileFetchError)) throw error;
        failures.push({ tile, url, reason: error.message });
        if (error.network && completed === 0) {
          consecutiveNetwork += 1;
          if (consecutiveNetwork >= 4) {
            corsBlocked = true;
            stop = true;
          }
        } else if (!error.network) {
          consecutiveNetwork = 0;
        }
      } finally {
        inFlight = Math.max(0, inFlight - 1);
        report();
      }
    }
  };

  const poolSize = Math.max(1, Math.min(concurrency, tiles.length || 1));
  if (tiles.length > 0) {
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
  }

  return {
    completed,
    failed: failures,
    bytes,
    cancelled: control.isCancelled(),
    corsBlocked,
  };
}

async function fetchWithRetry(url: string, signal: AbortSignal, maxTileBytes: number) {
  let lastError = new TileFetchError('Не удалось скачать тайл', true);
  for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt++) {
    if (signal.aborted) throw new DownloadCancelled();
    try {
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal,
      });
      if (!response.ok) {
        const permanent = response.status === 404;
        lastError = new TileFetchError(permanent ? 'Нет тайла (404)' : `HTTP ${response.status}`, false);
        if (!shouldRetry(response.status, attempt)) break;
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxTileBytes) {
        throw new TileFetchError('Тайл больше допустимого размера', false);
      }
      const raster = await ensureRaster(bytes);
      if (!raster) throw new TileFetchError('Ответ не является изображением', false);
      return raster;
    } catch (error) {
      if (error instanceof DownloadCancelled || error instanceof TileFetchError) {
        if (error instanceof TileFetchError && !error.network) throw error;
        if (error instanceof DownloadCancelled) throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') throw new DownloadCancelled();
      const detail = error instanceof Error ? error.message : 'fetch не удался';
      lastError = new TileFetchError(`Сеть: ${detail}`, true);
      if (!shouldRetry(null, attempt)) break;
      await sleep(backoffMs(attempt), signal);
    }
  }
  throw lastError;
}
