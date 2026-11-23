import { xyzToQuadKey } from './quadkey';
import { xyzToTmsY, type TileCoord } from './tiles';

export interface TileSource {
  id: string;
  title: string;
  detail: string;
  attribution: string;
  terms: string;
  urlTemplate: string;
  subdomains: string[];
  needsKey: boolean;
  maxZoom: number;
}

export const TILE_SOURCES: TileSource[] = [
  {
    id: 'esri',
    title: 'Esri World Imagery',
    detail: 'Спутник Esri. Обычно отдаёт CORS, поэтому сборка файла из браузера чаще всего проходит.',
    attribution: 'Esri, Maxar, Earthstar Geographics и сообщество GIS',
    terms: 'У Esri свои условия использования World Imagery. Массовая выгрузка может быть ограничена.',
    urlTemplate:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    subdomains: [],
    needsKey: false,
    maxZoom: 19,
  },
  {
    id: 'google',
    title: 'Google Satellite',
    detail: 'Спутник Google. Браузер часто блокирует чтение тайлов из-за CORS — карта при этом всё равно видна.',
    attribution: 'Google',
    terms: 'Условия Google обычно запрещают массовое скачивание и хранение тайлов. Это ваш выбор и ваша ответственность.',
    urlTemplate: 'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
    subdomains: ['0', '1', '2', '3'],
    needsKey: false,
    maxZoom: 21,
  },
  {
    id: 'bing',
    title: 'Bing Aerial',
    detail: 'Аэрофото Bing через quadkey. CORS с произвольного сайта, как правило, закрыт.',
    attribution: 'Microsoft Bing',
    terms: 'Условия Microsoft Bing Maps запрещают многие виды сохранения тайлов. Проверьте их до скачивания.',
    urlTemplate: 'https://ecn.t{s}.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=14384',
    subdomains: ['0', '1', '2', '3'],
    needsKey: false,
    maxZoom: 19,
  },
  {
    id: 'maptiler',
    title: 'MapTiler Satellite',
    detail: 'Нужен свой ключ MapTiler. Ключ пишется только в localStorage этого браузера.',
    attribution: 'MapTiler',
    terms: 'Действуют условия и квота вашего ключа MapTiler.',
    urlTemplate: 'https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key={key}',
    subdomains: [],
    needsKey: true,
    maxZoom: 20,
  },
  {
    id: 'mapbox',
    title: 'Mapbox Satellite',
    detail: 'Нужен свой токен Mapbox. Токен не отправляется никуда, кроме серверов Mapbox.',
    attribution: 'Mapbox',
    terms: 'Действуют условия и квота вашего токена Mapbox.',
    urlTemplate:
      'https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/256/{z}/{x}/{y}?access_token={key}',
    subdomains: [],
    needsKey: true,
    maxZoom: 22,
  },
  {
    id: 'custom',
    title: 'Свой шаблон XYZ',
    detail: 'Любой URL с подстановками. Так можно указать свой сервер тайлов, если у публичного источника нет CORS.',
    attribution: 'Задаётся шаблоном',
    terms: 'Вы отвечаете за права на этот источник.',
    urlTemplate: '',
    subdomains: [],
    needsKey: false,
    maxZoom: 22,
  },
];

export const YANDEX_EXCLUSION = {
  title: 'Яндекс Спутник',
  reason:
    'Тайлы Яндекса нарезаны в эллиптическом Меркаторе EPSG:3395, а MBTiles и наземные станции читают их как Web Mercator EPSG:3857. Без перепроецирования каждого пикселя снимок встанет со сдвигом, особенно севернее средней полосы. Чтобы файл открывался без смещения, этот источник не предлагается.',
};

export function sourceById(id: string): TileSource {
  return TILE_SOURCES.find((source) => source.id === id) ?? TILE_SOURCES[0]!;
}

export interface UrlOptions {
  key?: string;
  subdomains?: string[];
  template?: string;
}

export function buildTileUrl(source: TileSource, tile: TileCoord, options: UrlOptions = {}): string {
  const template = (options.template ?? source.urlTemplate).trim();
  const subdomains = options.subdomains?.length ? options.subdomains : source.subdomains;
  const subdomain = subdomains.length ? subdomains[(tile.x + tile.y) % subdomains.length]! : '';
  const key = encodeURIComponent(options.key ?? '');
  return template
    .replaceAll('{quadkey}', xyzToQuadKey(tile.x, tile.y, tile.z))
    .replaceAll('{s}', subdomain)
    .replaceAll('{z}', String(tile.z))
    .replaceAll('{x}', String(tile.x))
    .replaceAll('{-y}', String(xyzToTmsY(tile.y, tile.z)))
    .replaceAll('{y}', String(tile.y))
    .replaceAll('{key}', key);
}

export function templateIsUsable(template: string): boolean {
  const hasQuad = template.includes('{quadkey}');
  const hasXY = template.includes('{x}') && (template.includes('{y}') || template.includes('{-y}'));
  return template.startsWith('https://') && template.includes('{z}') && (hasQuad || hasXY);
}

export function parseSubdomains(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
