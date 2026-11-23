import L from 'leaflet';
import { useEffect, useRef } from 'react';
import { buildTileUrl, type TileSource } from '../lib/sources';

interface MapViewProps {
  lat: number;
  lon: number;
  radiusM: number;
  source: TileSource;
  template: string;
  subdomains: string[];
  apiKey: string;
  showOsm: boolean;
  canPreviewImagery: boolean;
  onPick: (lat: number, lon: number) => void;
}

const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '© OpenStreetMap';

export function MapView({
  lat,
  lon,
  radiusM,
  source,
  template,
  subdomains,
  apiKey,
  showOsm,
  canPreviewImagery,
  onPick,
}: MapViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tilesRef = useRef<L.TileLayer | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const skipFly = useRef(true);
  const pickFromMap = useRef(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || mapRef.current) return;
    const map = L.map(host, {
      zoomControl: true,
      attributionControl: true,
      minZoom: 2,
      maxZoom: 20,
    }).setView([lat, lon], 13);
    map.attributionControl.setPrefix(false);
    L.control.scale({ imperial: false, metric: true }).addTo(map);
    map.on('click', (event: L.LeafletMouseEvent) => {
      pickFromMap.current = true;
      onPickRef.current(event.latlng.lat, event.latlng.lng);
    });
    mapRef.current = map;
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // The map is created once. Later center changes go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tilesRef.current?.remove();
    const imagery = !showOsm && canPreviewImagery;
    const layer = imagery
      ? new ImageryLayer((coords) => buildTileUrl(source, { z: coords.z, x: coords.x, y: coords.y }, { template, subdomains, key: apiKey }), {
          maxZoom: Math.min(20, source.maxZoom),
          attribution: source.attribution,
        })
      : L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR });
    layer.addTo(map);
    tilesRef.current = layer;
  }, [apiKey, canPreviewImagery, showOsm, source, subdomains, template]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (skipFly.current) {
      skipFly.current = false;
      return;
    }
    if (pickFromMap.current) {
      pickFromMap.current = false;
      return;
    }
    map.flyTo([lat, lon], Math.max(map.getZoom(), 12), { duration: 0.55 });
  }, [lat, lon]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    circleRef.current?.remove();
    markerRef.current?.remove();
    circleRef.current = L.circle([lat, lon], {
      radius: radiusM,
      color: '#d6f25c',
      weight: 2,
      opacity: 0.95,
      fillColor: '#d6f25c',
      fillOpacity: 0.14,
      dashArray: '7 7',
    }).addTo(map);
    markerRef.current = L.circleMarker([lat, lon], {
      radius: 5,
      color: '#10140f',
      weight: 2,
      fillColor: '#d6f25c',
      fillOpacity: 1,
    }).addTo(map);
  }, [lat, lon, radiusM]);

  return <div ref={hostRef} className="map" />;
}

class ImageryLayer extends L.TileLayer {
  constructor(
    private readonly resolveUrl: (coords: L.Coords) => string,
    options: L.TileLayerOptions,
  ) {
    super('', options);
  }

  override getTileUrl(coords: L.Coords): string {
    return this.resolveUrl(coords);
  }
}
