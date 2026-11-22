import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, LngLatLike } from 'maplibre-gl';
import type { Feature } from 'geojson';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// MapLibre 6 calcula la URL del worker en tiempo de ejecución; con Vite hay que indicarla
maplibregl.setWorkerUrl(workerUrl);
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LngLat } from '../lib/geo';
import { socColor } from './ui';

export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
export const MAP_STYLE_NIGHT = 'https://tiles.openfreemap.org/styles/dark';

/** De noche (20:00–07:00) usamos el mapa oscuro para no encandilar */
export const isNight = (d = new Date()) =>
  new URLSearchParams(location.search).has('noche') || d.getHours() >= 20 || d.getHours() < 7;

export default function MapView({
  center = [-70.65, -33.44],
  zoom = 10,
  pitch = 0,
  onReady,
  style,
  className,
  interactive = true,
  night = false,
}: {
  center?: LngLat;
  zoom?: number;
  pitch?: number;
  onReady?: (map: MlMap) => void;
  style?: React.CSSProperties;
  className?: string;
  interactive?: boolean;
  night?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    if (!ref.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: night ? MAP_STYLE_NIGHT : MAP_STYLE,
      center: center as LngLatLike,
      zoom,
      pitch,
      interactive,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 150,
    });
    map.touchZoomRotate.disableRotation();
    if (import.meta.env.DEV) (window as unknown as { __maps: MlMap[] }).__maps = [...((window as unknown as { __maps?: MlMap[] }).__maps ?? []), map];
    map.on('load', () => {
      if (!night) tintStyle(map);
      readyRef.current?.(map);
    });
    return () => map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={ref} className={className} style={{ width: '100%', height: '100%', ...style }} />;
}

/** Ajusta levemente el estilo base: agua y parques con tonos de la app */
function tintStyle(map: MlMap) {
  try {
    for (const layer of map.getStyle().layers ?? []) {
      if (layer.type === 'fill' && /water/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#d6e6ff');
      if (layer.type === 'fill' && /park|wood|grass/.test(layer.id)) map.setPaintProperty(layer.id, 'fill-color', '#e6f4ec');
    }
  } catch {
    /* estilo distinto: ignorar */
  }
}

/** Dibuja (o actualiza) la ruta coloreada por nivel de batería */
export function drawRoute(map: MlMap, coords: LngLat[], soc?: number[], cum?: number[], id = 'route') {
  const data: Feature = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data);
  else {
    map.addSource(id, { type: 'geojson', data, lineMetrics: true });
    map.addLayer({
      id: `${id}-casing`,
      type: 'line',
      source: id,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 6, 14, 14] },
    });
    map.addLayer({
      id: `${id}-line`,
      type: 'line',
      source: id,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#1463FF', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 14, 8] },
    });
  }
  if (soc && soc.length > 1) {
    const n = soc.length;
    const total = cum ? cum[n - 1] || 1 : n - 1;
    const steps = Math.min(120, n);
    const expr: unknown[] = ['interpolate', ['linear'], ['line-progress']];
    let last = -1;
    for (let k = 0; k < steps; k++) {
      const target = (k / (steps - 1)) * total;
      const i = Math.min(n - 1, cum ? lowerBound(cum, target) : Math.round(target));
      const f = Math.min(1, (cum ? cum[i] : i) / total);
      if (f <= last) continue;
      last = f;
      expr.push(f, socColor(soc[i]));
    }
    if (expr.length >= 7) map.setPaintProperty(`${id}-line`, 'line-gradient', expr as never);
  }
}

/** Otras rutas posibles en gris, debajo de la ruta elegida */
export function drawAlternatives(map: MlMap, lines: LngLat[][], id = 'route-alts') {
  const data = {
    type: 'FeatureCollection' as const,
    features: lines.map((coordinates) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates } })),
  };
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    return;
  }
  map.addSource(id, { type: 'geojson', data });
  const before = map.getLayer('route-casing') ? 'route-casing' : undefined;
  map.addLayer(
    {
      id: `${id}-casing`,
      type: 'line',
      source: id,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 5, 14, 11] },
    },
    before,
  );
  map.addLayer(
    {
      id: `${id}-line`,
      type: 'line',
      source: id,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#9fb0cf', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 14, 6] },
    },
    before,
  );
}

/** Puntos de cargadores como capa (escala con el zoom, no tapa la ruta) */
export function drawChargerDots(map: MlMap, points: { lng: number; lat: number; color: string }[], id = 'route-chargers') {
  const data = {
    type: 'FeatureCollection' as const,
    features: points.map((p) => ({ type: 'Feature' as const, properties: { color: p.color }, geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] } })),
  };
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
    return;
  }
  map.addSource(id, { type: 'geojson', data });
  map.addLayer({
    id,
    type: 'circle',
    source: id,
    paint: {
      'circle-color': ['get', 'color'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 9, 4.5, 13, 7, 16, 9],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 12, 2.5],
    },
  });
}

function lowerBound(arr: number[], v: number) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function removeRoute(map: MlMap, id = 'route') {
  for (const l of [`${id}-line`, `${id}-casing`]) if (map.getLayer(l)) map.removeLayer(l);
  if (map.getSource(id)) map.removeSource(id);
}

export function fitTo(map: MlMap, coords: LngLat[], padding: maplibregl.PaddingOptions | number = 50, animate = true) {
  if (!coords.length) return;
  const b = new maplibregl.LngLatBounds(coords[0] as LngLatLike, coords[0] as LngLatLike);
  for (const c of coords) b.extend(c as LngLatLike);
  map.fitBounds(b, { padding, duration: animate ? 800 : 0, maxZoom: 15 });
}

export function htmlMarker(html: string, className = '') {
  const el = document.createElement('div');
  el.className = className;
  el.innerHTML = html;
  return el;
}

export { maplibregl };
