import { useEffect, useMemo, useRef, useState } from 'react';
import { MapView } from './components/MapView';
import {
  DOWNLOAD_CONCURRENCY,
  ENUM_TILE_LIMIT,
  ESTIMATED_TILE_BYTES,
  HARD_TILE_CAP,
  MAX_TILE_BYTES,
  WARN_TILE_COUNT,
} from './lib/constants';
import { parseCoordinates } from './lib/coords';
import {
  PauseController,
  corsExplanation,
  downloadTiles,
  probeTileUrl,
  type DownloadProgress,
  type TileFailure,
} from './lib/download';
import { defaultMapName, fileBasename, formatBytes, formatCount, tileNoun } from './lib/format';
import { MbtilesBuilder } from './lib/mbtiles';
import { QGC_PROVIDERS, QgcTileDbBuilder, qgcProviderById } from './lib/qgctiledb';
import { loadSql } from './lib/sql-browser';
import {
  TILE_SOURCES,
  YANDEX_EXCLUSION,
  buildTileUrl,
  parseSubdomains,
  sourceById,
  templateIsUsable,
} from './lib/sources';
import { clearSecretSettings, loadSettings, saveSettings, type Settings } from './lib/storage';
import { toArrayBuffer } from './lib/bytes';
import { circleBounds, planTiles } from './lib/tiles';
import { zipTiles, type ZipLayout } from './lib/zipxyz';

type Phase = 'idle' | 'probing' | 'running' | 'paused' | 'done' | 'cancelled';

interface AccessState {
  key: string;
  status: 'unknown' | 'checking' | 'ok' | 'bad';
  message: string;
}

interface ReadyFiles {
  base: string;
  mbtiles: Uint8Array;
  qgc: Uint8Array | null;
  zip: Uint8Array | null;
  failures: TileFailure[];
  completed: number;
  bytes: number;
}

function qgcIdForSource(sourceId: string): string {
  if (sourceId === 'google') return 'google-satellite';
  if (sourceId === 'bing') return 'bing-satellite';
  if (sourceId === 'mapbox') return 'mapbox-satellite';
  return 'esri-satellite';
}

function sliderToMeters(value: number): number {
  const min = Math.log(100);
  const max = Math.log(50_000);
  return Math.round(Math.exp(min + (value / 100) * (max - min)));
}

function metersToSlider(meters: number): number {
  const min = Math.log(100);
  const max = Math.log(50_000);
  const clamped = Math.min(50_000, Math.max(100, meters));
  return ((Math.log(clamped) - min) / (max - min)) * 100;
}

function saveFile(filename: string, data: Uint8Array, mime: string): void {
  const blob = new Blob([toArrayBuffer(data)], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const unit = settings.radiusUnit;
  const [showOsm, setShowOsm] = useState(false);
  const [coordText, setCoordText] = useState('');
  const [coordMessage, setCoordMessage] = useState('');
  const [geoMessage, setGeoMessage] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [banner, setBanner] = useState('');
  const [access, setAccess] = useState<AccessState>({ key: '', status: 'unknown', message: '' });
  const [files, setFiles] = useState<ReadyFiles | null>(null);
  const controlRef = useRef<PauseController | null>(null);
  const paintedAt = useRef(0);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const patch = (partial: Partial<Settings>) => setSettings((prev) => ({ ...prev, ...partial }));
  const source = sourceById(settings.sourceId);
  const apiKey = source.id === 'maptiler' ? settings.maptilerKey : source.id === 'mapbox' ? settings.mapboxKey : '';
  const subdomains = useMemo(
    () => (source.id === 'custom' ? parseSubdomains(settings.customSubdomains) : source.subdomains),
    [settings.customSubdomains, source],
  );
  const template = source.id === 'custom' ? settings.customUrl : source.urlTemplate;
  const plan = useMemo(
    () => planTiles(settings.lat, settings.lon, settings.radiusM, settings.minZoom, settings.maxZoom),
    [settings.lat, settings.lon, settings.radiusM, settings.minZoom, settings.maxZoom],
  );

  const templateOk = source.id !== 'custom' || templateIsUsable(template);
  const keyOk = !source.needsKey || apiKey.trim().length > 0;
  const qgcMismatch = settings.alsoQgc && settings.qgcNoGoogle && settings.qgcProviderId === 'google-satellite';
  const overCap = plan.overflow || plan.tiles.length > HARD_TILE_CAP;
  const busy = phase === 'probing' || phase === 'running' || phase === 'paused';

  let blockReason: string | null = null;
  if (plan.overflow) {
    blockReason = `В описывающем прямоугольнике больше ${formatCount(ENUM_TILE_LIMIT)} тайлов. Уменьшите радиус или диапазон масштабов. Считаются только тайлы, которые пересекает круг, но перебирать такой прямоугольник уже бессмысленно.`;
  } else if (plan.tiles.length > HARD_TILE_CAP) {
    blockReason = `Нужно ${formatCount(plan.tiles.length)} ${tileNoun(plan.tiles.length)}, лимит ${formatCount(HARD_TILE_CAP)}. База собирается в памяти браузера — больший файл может закрыть вкладку. Уменьшите радиус или верхний масштаб.`;
  } else if (plan.tiles.length === 0) {
    blockReason = 'Круг не задевает ни одного тайла на выбранных масштабах.';
  } else if (!keyOk) {
    blockReason = 'Нужен ключ API. Он хранится только в localStorage этого браузера и уходит лишь провайдеру тайлов.';
  } else if (!templateOk) {
    blockReason = 'Шаблон должен начинаться с https:// и содержать {z} вместе с {x} и {y} (или {-y}), либо {quadkey}.';
  } else if (qgcMismatch) {
    blockReason = 'В сборке QGC без Google нет слота Google Satellite. Выберите другой тип карты для файла .qgctiledb.';
  }

  const estimateBytes = (plan.overflow ? ENUM_TILE_LIMIT : plan.tiles.length) * ESTIMATED_TILE_BYTES;
  const estimateClass = overCap ? 'is-bad' : plan.tiles.length >= WARN_TILE_COUNT ? 'is-warn' : '';
  const shownRadius = unit === 'km' ? settings.radiusM / 1000 : settings.radiusM;
  const accessKey = `${source.id}|${template}|${apiKey}|${subdomains.join(',')}`;
  const visibleAccess = access.key === accessKey ? access : { key: accessKey, status: 'unknown' as const, message: '' };

  function commitRadius(raw: string) {
    const value = Number(raw.trim().replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return;
    const meters = unit === 'km' ? value * 1000 : value;
    patch({ radiusM: Math.min(500_000, Math.max(50, meters)) });
  }

  function commitZoom(which: 'min' | 'max', raw: string) {
    const value = Number(raw.trim());
    if (!Number.isInteger(value)) return;
    const zoom = Math.min(20, Math.max(0, value));
    setSettings((prev) =>
      which === 'min'
        ? { ...prev, minZoom: zoom, maxZoom: Math.max(zoom, prev.maxZoom) }
        : { ...prev, maxZoom: zoom, minZoom: Math.min(zoom, prev.minZoom) },
    );
  }

  function applyCoordinates() {
    const parsed = parseCoordinates(coordText);
    if (!parsed) {
      setCoordMessage('Не разобрал. Пример: 55.751244, 37.618423 или 55°45′04″N 37°37′06″E.');
      return;
    }
    setCoordMessage('');
    patch({ lat: parsed.lat, lon: parsed.lon });
  }

  function locate() {
    if (!navigator.geolocation) {
      setGeoMessage('Этот браузер не отдаёт геолокацию.');
      return;
    }
    setGeoMessage('Запрашиваю положение…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGeoMessage('');
        patch({ lat: position.coords.latitude, lon: position.coords.longitude });
      },
      (error) => {
        const text =
          error.code === error.PERMISSION_DENIED
            ? 'Доступ к геолокации запрещён.'
            : error.code === error.TIMEOUT
              ? 'Геолокация не ответила вовремя.'
              : 'Положение недоступно.';
        setGeoMessage(text);
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  }

  async function checkAccess() {
    if (!templateOk || !keyOk || plan.tiles.length === 0) return;
    const tile = plan.tiles[Math.min(plan.tiles.length - 1, Math.floor(plan.tiles.length / 2))] ?? plan.tiles[0]!;
    const url = buildTileUrl(source, tile, { template, subdomains, key: apiKey });
    setAccess({ key: accessKey, status: 'checking', message: 'Проверяю один тайл…' });
    const result = await probeTileUrl(url);
    setAccess({
      key: accessKey,
      status: result.ok ? 'ok' : 'bad',
      message: result.message,
    });
  }

  async function startDownload() {
    if (busy || blockReason) return;
    setBanner('');
    setFiles(null);
    const tiles = plan.tiles;
    const control = new PauseController();
    controlRef.current = control;
    const urlFor = (tile: { z: number; x: number; y: number }) =>
      buildTileUrl(source, tile, { template, subdomains, key: apiKey });
    setPhase('probing');
    const probe = await probeTileUrl(urlFor(tiles[0]!), control.signal);
    setAccess({ key: accessKey, status: probe.ok ? 'ok' : 'bad', message: probe.message });
    if (!probe.ok || control.isCancelled()) {
      setPhase(control.isCancelled() ? 'cancelled' : 'idle');
      setBanner(probe.ok ? '' : probe.message);
      return;
    }

    const name = settings.mapName.trim() || defaultMapName(settings.lat, settings.lon, settings.radiusM);
    const radiusLabel = settings.radiusM >= 1000 ? `${(settings.radiusM / 1000).toFixed(1)} км` : `${Math.round(settings.radiusM)} м`;
    const attribution = source.id === 'custom' ? 'Пользовательский источник тайлов' : source.attribution;
    const box = circleBounds(settings.lat, settings.lon, settings.radiusM);
    const SQL = await loadSql();
    const mbtiles = MbtilesBuilder.create(SQL, {
      name,
      attribution,
      description: `${source.title}. Радиус ${radiusLabel}, масштабы ${settings.minZoom}–${settings.maxZoom}. Собрано в браузере, sputnik-mbtiles.`,
      centerLon: settings.lon,
      centerLat: settings.lat,
    });
    const qgc = settings.alsoQgc
      ? QgcTileDbBuilder.create(SQL, {
          name,
          provider: qgcProviderById(settings.qgcProviderId),
          noGoogleBuild: settings.qgcNoGoogle,
          north: box.north,
          west: box.crossesAntimeridian ? -180 : box.west,
          south: box.south,
          east: box.crossesAntimeridian ? 180 : box.east,
          minZoom: settings.minZoom,
          maxZoom: settings.maxZoom,
        })
      : null;

    setPhase('running');
    setProgress({ total: tiles.length, completed: 0, failed: 0, bytes: 0, inFlight: 0 });
    try {
      const result = await downloadTiles({
        tiles,
        urlFor,
        control,
        concurrency: DOWNLOAD_CONCURRENCY,
        maxTileBytes: MAX_TILE_BYTES,
        onTile: (tile, bytes, format) => {
          mbtiles.addTile(tile, bytes, format);
          qgc?.addTile(tile, bytes, format);
        },
        onProgress: (next) => {
          const now = performance.now();
          const finished = next.completed + next.failed >= next.total;
          if (!finished && now - paintedAt.current < 80) return;
          paintedAt.current = now;
          setProgress(next);
        },
      });
      setProgress({
        total: tiles.length,
        completed: result.completed,
        failed: result.failed.length,
        bytes: result.bytes,
        inFlight: 0,
      });
      if (result.cancelled) {
        setPhase('cancelled');
        setBanner('Загрузка отменена. Файл не сохранён.');
        return;
      }
      if (result.corsBlocked && result.completed === 0) {
        setPhase('idle');
        setBanner(corsExplanation());
        setAccess({ key: accessKey, status: 'bad', message: corsExplanation() });
        return;
      }
      if (result.completed === 0) {
        setPhase('idle');
        setBanner('Ни один тайл не скачался. Файл не создан.');
        return;
      }

      const built = mbtiles.finish();
      let zip: Uint8Array | null = null;
      if (settings.alsoZip) {
        const packed: Array<{ tile: { z: number; x: number; y: number }; data: Uint8Array }> = [];
        mbtiles.eachTile((tile, data) => packed.push({ tile, data }));
        zip = zipTiles(packed, settings.zipLayout, built.format === 'png' ? 'png' : 'jpg');
      }
      const qgcBytes = qgc ? qgc.finish() : null;
      const base = fileBasename(settings.lat, settings.lon, settings.radiusM, settings.minZoom, settings.maxZoom);
      const ready: ReadyFiles = {
        base,
        mbtiles: built.bytes,
        qgc: qgcBytes,
        zip,
        failures: result.failed,
        completed: result.completed,
        bytes: result.bytes,
      };
      setFiles(ready);
      setPhase('done');
      const missed = result.failed.length
        ? ` Без ${formatCount(result.failed.length)} тайлов — в этих местах на станции будет пусто.`
        : '';
      setBanner(`Файл собран: ${formatCount(result.completed)} ${tileNoun(result.completed)}, ${formatBytes(built.bytes.byteLength)}.${missed}`);
      saveFile(`${base}.mbtiles`, built.bytes, 'application/octet-stream');
      if (qgcBytes) window.setTimeout(() => saveFile(`${base}.qgctiledb`, qgcBytes, 'application/octet-stream'), 500);
      if (zip) window.setTimeout(() => saveFile(`${base}.zip`, zip, 'application/zip'), 1000);
    } catch (error) {
      setPhase('idle');
      setBanner(error instanceof Error ? error.message : 'Не удалось собрать файл.');
    } finally {
      mbtiles.close();
      qgc?.close();
      controlRef.current = null;
    }
  }

  function pauseOrResume() {
    const control = controlRef.current;
    if (!control) return;
    if (phase === 'paused') {
      control.resume();
      setPhase('running');
    } else if (phase === 'running') {
      control.pause();
      setPhase('paused');
    }
  }

  function cancel() {
    controlRef.current?.cancel();
  }

  const pct = progress && progress.total > 0 ? Math.round(((progress.completed + progress.failed) / progress.total) * 100) : 0;

  return (
    <div className="app">
      <aside className="panel">
        <div className="panel-scroll">
          <header className="brand">
            <div className="mark" aria-hidden="true" />
            <div>
              <h1>Спутник</h1>
              <p>Офлайн-снимки в MBTiles для наземной станции</p>
            </div>
          </header>

          <section className="section" style={{ borderTop: 'none', paddingTop: 0 }}>
            <h2>Источник</h2>
            <div className="source-list">
              {TILE_SOURCES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === source.id ? 'source is-on' : 'source'}
                  aria-pressed={item.id === source.id}
                  onClick={() => patch({ sourceId: item.id, qgcProviderId: qgcIdForSource(item.id) })}
                  disabled={busy}
                >
                  <span className="source-name">{item.title}</span>
                  <span className="source-detail">{item.detail}</span>
                </button>
              ))}
              <div className="source is-off">
                <span className="source-name">{YANDEX_EXCLUSION.title}</span>
                <span className="source-detail">{YANDEX_EXCLUSION.reason}</span>
              </div>
            </div>
            <p className="note">{source.terms} Условия провайдера соблюдаете вы. Приложение не ходит через прокси и не отправляет ключи на свой сервер — сервера нет.</p>
            {source.needsKey && (
              <label className="field" style={{ marginTop: 10 }}>
                {source.id === 'mapbox' ? 'Токен Mapbox' : 'Ключ MapTiler'}
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) =>
                    patch(source.id === 'mapbox' ? { mapboxKey: event.target.value } : { maptilerKey: event.target.value })
                  }
                  disabled={busy}
                />
              </label>
            )}
            {source.id === 'custom' && (
              <div className="stack" style={{ marginTop: 10 }}>
                <label className="field">
                  Шаблон URL
                  <textarea
                    value={settings.customUrl}
                    spellCheck={false}
                    onChange={(event) => patch({ customUrl: event.target.value })}
                    disabled={busy}
                  />
                </label>
                <label className="field">
                  Поддомены для {'{s}'}, через запятую
                  <input
                    type="text"
                    value={settings.customSubdomains}
                    onChange={(event) => patch({ customSubdomains: event.target.value })}
                    placeholder="a, b, c"
                    disabled={busy}
                  />
                </label>
                <p className="note">Подстановки: {'{z}'} {'{x}'} {'{y}'} {'{-y}'} (строка TMS) {'{quadkey}'} {'{s}'} {'{key}'}.</p>
              </div>
            )}
            <p className={`status ${visibleAccess.status === 'ok' ? 'ok' : visibleAccess.status === 'bad' ? 'bad' : ''}`}>
              {visibleAccess.status === 'unknown'
                ? 'Доступ из браузера ещё не проверен.'
                : visibleAccess.message}
            </p>
            <button type="button" className="ghost" onClick={() => void checkAccess()} disabled={busy || !templateOk || !keyOk}>
              Проверить CORS
            </button>
          </section>

          <section className="section">
            <h2>Центр</h2>
            <div className="row">
              <label className="field">
                Широта
                <input
                  className="mono"
                  type="number"
                  step="0.000001"
                  min={-90}
                  max={90}
                  value={roundInput(settings.lat)}
                  onChange={(event) => patch({ lat: clampNumber(event.target.value, settings.lat, -90, 90) })}
                  disabled={busy}
                />
              </label>
              <label className="field">
                Долгота
                <input
                  className="mono"
                  type="number"
                  step="0.000001"
                  min={-180}
                  max={180}
                  value={roundInput(settings.lon)}
                  onChange={(event) => patch({ lon: clampNumber(event.target.value, settings.lon, -180, 180) })}
                  disabled={busy}
                />
              </label>
            </div>
            <label className="field" style={{ marginTop: 8 }}>
              Вставить координаты, десятичные или DMS
              <input
                type="text"
                value={coordText}
                placeholder="55.751244, 37.618423"
                onChange={(event) => setCoordText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyCoordinates();
                }}
                disabled={busy}
              />
            </label>
            <div className="actions" style={{ marginTop: 8 }}>
              <button type="button" className="ghost" onClick={applyCoordinates} disabled={busy}>
                Найти
              </button>
              <button type="button" className="ghost" onClick={locate} disabled={busy}>
                Моё положение
              </button>
            </div>
            {coordMessage && <p className="status bad">{coordMessage}</p>}
            {geoMessage && <p className="status">{geoMessage}</p>}
          </section>

          <section className="section">
            <h2>Радиус</h2>
            <div className="row">
              <label className="field">
                {unit === 'km' ? 'Километры' : 'Метры'}
                <DraftInput
                  className="mono"
                  disabled={busy}
                  value={unit === 'km' ? String(trimKm(shownRadius)) : String(Math.round(shownRadius))}
                  onCommit={commitRadius}
                />
              </label>
              <div className="unit" role="group" aria-label="Единицы радиуса">
                <button type="button" className={unit === 'm' ? 'is-on' : ''} onClick={() => patch({ radiusUnit: 'm' })} disabled={busy}>
                  м
                </button>
                <button type="button" className={unit === 'km' ? 'is-on' : ''} onClick={() => patch({ radiusUnit: 'km' })} disabled={busy}>
                  км
                </button>
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={0.1}
              value={metersToSlider(settings.radiusM)}
              aria-label="Радиус"
              onChange={(event) => patch({ radiusM: sliderToMeters(Number(event.target.value)) })}
              disabled={busy}
            />
          </section>

          <section className="section">
            <h2>Масштабы в файле</h2>
            <div className="chips" role="group" aria-label="Готовые диапазоны">
              {[
                [12, 14, 'Обзор 12–14'],
                [15, 17, 'Маршрут 15–17'],
                [16, 18, 'Детально 16–18'],
              ].map(([min, max, label]) => (
                <button
                  key={label as string}
                  type="button"
                  onClick={() => patch({ minZoom: min as number, maxZoom: max as number })}
                  disabled={busy}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <label className="field">
                От
                <DraftInput
                  className="mono"
                  disabled={busy}
                  value={String(settings.minZoom)}
                  onCommit={(raw) => commitZoom('min', raw)}
                />
              </label>
              <label className="field">
                До
                <DraftInput
                  className="mono"
                  disabled={busy}
                  value={String(settings.maxZoom)}
                  onCommit={(raw) => commitZoom('max', raw)}
                />
              </label>
            </div>
            <label className="check" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={showOsm} onChange={(event) => setShowOsm(event.target.checked)} />
              <span>Подложка-схема OpenStreetMap, чтобы найти место. В файл она не попадает.</span>
            </label>
          </section>

          <section className="section">
            <h2>Оценка</h2>
            <div className={`estimate ${estimateClass}`}>
              <strong>{plan.overflow ? `> ${formatCount(ENUM_TILE_LIMIT)}` : formatCount(plan.tiles.length)}</strong>
              <p>
                {plan.overflow ? 'тайлов' : tileNoun(plan.tiles.length)}, примерно {formatBytes(estimateBytes)}. Лимит {formatCount(HARD_TILE_CAP)}. Оценка размера грубая: спутниковый JPEG бывает и 15, и 50 КБ.
                {plan.tiles.length >= WARN_TILE_COUNT && !overCap
                  ? ' Объём уже большой: при сохранении браузер коротко держит вторую копию базы.'
                  : ''}
              </p>
              {!plan.overflow && (
                <div className="zoom-table">
                  {Object.entries(plan.byZoom).map(([zoom, count]) => (
                    <span key={zoom}>
                      z{zoom} {formatCount(count)}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {blockReason && <p className="status bad">{blockReason}</p>}
          </section>

          <section className="section">
            <h2>Файл</h2>
            <label className="field">
              Имя в метаданных
              <input
                type="text"
                value={settings.mapName}
                placeholder={defaultMapName(settings.lat, settings.lon, settings.radiusM)}
                onChange={(event) => patch({ mapName: event.target.value })}
                disabled={busy}
              />
            </label>
            <label className="check" style={{ marginTop: 10 }}>
              <input
                type="checkbox"
                checked={settings.alsoZip}
                onChange={(event) => patch({ alsoZip: event.target.checked })}
                disabled={busy}
              />
              <span>Также ZIP с тайлами</span>
            </label>
            {settings.alsoZip && (
              <label className="field">
                Раскладка ZIP
                <select
                  value={settings.zipLayout}
                  onChange={(event) => patch({ zipLayout: event.target.value as ZipLayout })}
                  disabled={busy}
                >
                  <option value="xyz">XYZ: z/x/y</option>
                  <option value="mp">Mission Planner: Custom/z/y/x.jpg</option>
                </select>
              </label>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={settings.alsoQgc}
                onChange={(event) => patch({ alsoQgc: event.target.checked })}
                disabled={busy}
              />
              <span>Также .qgctiledb для стабильного QGroundControl. Сам MBTiles текущий QGC не импортирует.</span>
            </label>
            {settings.alsoQgc && (
              <div className="stack">
                <label className="field">
                  Слот карты в QGC, под который пишется хэш тайла
                  <select
                    value={settings.qgcProviderId}
                    onChange={(event) => patch({ qgcProviderId: event.target.value })}
                    disabled={busy}
                  >
                    {QGC_PROVIDERS.filter((provider) => !(settings.qgcNoGoogle && provider.id === 'google-satellite')).map(
                      (provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.qgcNoGoogle}
                    onChange={(event) => patch({ qgcNoGoogle: event.target.checked })}
                    disabled={busy}
                  />
                  <span>Сборка QGC без Google (QGC_NO_GOOGLE_MAPS) — номера слотов сдвинуты.</span>
                </label>
                <p className="note">
                  После импорта в QGC выберите тот же тип карты. Иначе станция ищет другой хэш и снимок не появится. Номера слотов сняты с текущей ветки master.
                </p>
              </div>
            )}
            <p className="note">Атрибуция в файле: {source.id === 'custom' ? 'пользовательский источник' : source.attribution}.</p>
          </section>

          <button type="button" className="primary" disabled={Boolean(blockReason) || busy} onClick={() => void startDownload()}>
            {phase === 'probing' ? 'Проверяю источник…' : phase === 'running' || phase === 'paused' ? 'Сборка идёт…' : 'Собрать файл'}
          </button>

          {busy && (
            <div style={{ marginTop: 12 }}>
              {phase !== 'probing' && (
                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                  <span style={{ width: `${pct}%` }} />
                </div>
              )}
              <p className="mono note">
                {phase === 'probing'
                  ? 'Проверка одного тайла…'
                  : progress
                    ? `${formatCount(progress.completed)} из ${formatCount(progress.total)} · ошибок ${formatCount(progress.failed)} · ${formatBytes(progress.bytes)}`
                    : '…'}
                {phase === 'paused' ? ' · пауза' : ''}
              </p>
              <div className="actions">
                {phase !== 'probing' && (
                  <button type="button" className="ghost" onClick={pauseOrResume}>
                    {phase === 'paused' ? 'Продолжить' : 'Пауза'}
                  </button>
                )}
                <button type="button" className="danger" onClick={cancel}>
                  Отмена
                </button>
              </div>
            </div>
          )}

          {banner && <p className={`status ${phase === 'done' ? 'ok' : phase === 'cancelled' ? 'warn' : 'bad'}`}>{banner}</p>}

          {files && (
            <div className="stack" style={{ marginTop: 10 }}>
              <div className="actions">
                <button type="button" className="ghost" onClick={() => saveFile(`${files.base}.mbtiles`, files.mbtiles, 'application/octet-stream')}>
                  MBTiles
                </button>
                {files.qgc && (
                  <button type="button" className="ghost" onClick={() => saveFile(`${files.base}.qgctiledb`, files.qgc!, 'application/octet-stream')}>
                    QGC
                  </button>
                )}
                {files.zip && (
                  <button type="button" className="ghost" onClick={() => saveFile(`${files.base}.zip`, files.zip!, 'application/zip')}>
                    ZIP
                  </button>
                )}
              </div>
              {files.failures.length > 0 && (
                <>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      saveFile(
                        `${files.base}-errors.txt`,
                        new TextEncoder().encode(
                          files.failures.map((failure) => `${failure.tile.z}/${failure.tile.x}/${failure.tile.y}\t${failure.reason}\t${failure.url}`).join('\n'),
                        ),
                        'text/plain',
                      )
                    }
                  >
                    Скачать отчёт об ошибках
                  </button>
                  <ul className="failures">
                    {files.failures.slice(0, 40).map((failure) => (
                      <li key={`${failure.tile.z}-${failure.tile.x}-${failure.tile.y}`}>
                        <span className="mono">
                          {failure.tile.z}/{failure.tile.x}/{failure.tile.y}
                        </span>{' '}
                        — {failure.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <section className="section help">
            <h2>Как открыть</h2>
            <details>
              <summary>QGroundControl</summary>
              <p>
                Стабильный QGC импортирует свой файл .qgctiledb, не MBTiles. Включите галочку выше, соберите оба файла. В QGC: значок Q → Application Settings → Maps / Offline Maps → Import. Укажите .qgctiledb и допишите набор к существующему кэшу. Затем выберите тот тип карты, под который собран хэш (для Esri это Esri World Satellite). На Android положите файл в каталог, который показывает диалог импорта, обычно QGroundControl/Missions.
              </p>
            </details>
            <details>
              <summary>Mission Planner</summary>
              <p>
                ZIP с раскладкой Mission Planner распакуйте так, чтобы путь совпал с кэшем: C:\ProgramData\Mission Planner\gmapcache\TileDBv3\en\Custom\z\y\x.jpg (на Linux — ~/.local/share/Mission Planner/gmapcache/…). Каталог языка может называться не en. На экране Plan выберите карту Custom. Чтение идёт только по имени .jpg. MBTiles Mission Planner напрямую не открывает; при установленном GDAL его можно подключить как растр.
              </p>
            </details>
            <details>
              <summary>Android GCS, в том числе пульт G12</summary>
              <p>
                Скопируйте .mbtiles на устройство. В приложении станции откройте офлайн-карты или слои и импортируйте MBTiles. Это обычный растровый MBTiles 1.1: Web Mercator, JPEG или PNG, строки тайлов в схеме TMS. Так файл читают QGIS, OsmAnd и библиотеки вроде osmdroid. Если станция ждёт каталог тайлов, распакуйте ZIP XYZ (z/x/y).
              </p>
            </details>
            <p>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const next = clearSecretSettings();
                  setSettings(next);
                }}
              >
                Забыть ключи API
              </button>
            </p>
          </section>
        </div>
      </aside>
      <div className="map-wrap">
        <MapView
          lat={settings.lat}
          lon={settings.lon}
          radiusM={settings.radiusM}
          source={source}
          template={template}
          subdomains={subdomains}
          apiKey={apiKey}
          showOsm={showOsm}
          canPreviewImagery={templateOk && (source.needsKey ? keyOk : true)}
          onPick={(lat, lon) => patch({ lat, lon })}
        />
        <div className="map-hint">Клик по карте ставит центр круга</div>
      </div>
    </div>
  );
}

function roundInput(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

function clampNumber(raw: string, fallback: number, min: number, max: number): number {
  if (raw.trim() === '' || raw === '-' || raw.endsWith('.')) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function trimKm(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function DraftInput({
  value,
  onCommit,
  disabled,
  className,
}: {
  value: string;
  onCommit: (raw: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className={className}
      type="text"
      inputMode="decimal"
      disabled={disabled}
      value={draft ?? value}
      onFocus={(event) => {
        setDraft(value);
        event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}
