export type LngLat = [number, number];

const R = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Distancia en metros entre dos puntos [lng, lat] */
export function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Decodifica polyline con precisión 6 (formato de Valhalla) → [lng, lat][] */
export function decodePolyline6(str: string): LngLat[] {
  const coords: LngLat[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const factor = 1e6;
  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

/** Distancias acumuladas (m) a lo largo de una polilínea */
export function cumulativeDistances(coords: LngLat[]): number[] {
  const out = new Array<number>(coords.length);
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) out[i] = out[i - 1] + haversine(coords[i - 1], coords[i]);
  return out;
}

/** Proyección local equirectangular (metros) relativa a un origen — suficiente para distancias cortas */
function project(p: LngLat, origin: LngLat): [number, number] {
  const x = toRad(p[0] - origin[0]) * Math.cos(toRad(origin[1])) * R;
  const y = toRad(p[1] - origin[1]) * R;
  return [x, y];
}

export interface Snap {
  /** índice del segmento (entre i e i+1) */
  index: number;
  /** fracción dentro del segmento */
  t: number;
  /** distancia perpendicular en metros */
  dist: number;
  /** distancia recorrida a lo largo de la ruta (m) */
  along: number;
  point: LngLat;
}

/**
 * Proyecta un punto sobre la ruta. Busca en una ventana alrededor de `hint` para ser rápido
 * durante la navegación; si `hint` es undefined, busca en toda la ruta.
 */
export function snapToRoute(
  p: LngLat,
  coords: LngLat[],
  cum: number[],
  hint?: number,
  windowBack = 30,
  windowFwd = 400,
): Snap {
  const from = hint === undefined ? 0 : Math.max(0, hint - windowBack);
  const to = hint === undefined ? coords.length - 1 : Math.min(coords.length - 1, hint + windowFwd);
  let best: Snap = { index: from, t: 0, dist: Infinity, along: cum[from] ?? 0, point: coords[from] };
  for (let i = from; i < to; i++) {
    const a = project(coords[i], p);
    const b = project(coords[i + 1], p);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(a[0] * dx + a[1] * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + t * dx;
    const py = a[1] + t * dy;
    const d = Math.hypot(px, py);
    if (d < best.dist) {
      const segLen = cum[i + 1] - cum[i];
      best = {
        index: i,
        t,
        dist: d,
        along: cum[i] + segLen * t,
        point: [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t],
      };
    }
  }
  return best;
}

/** Punto sobre la ruta a una distancia `along` (m) desde el inicio */
export function pointAt(coords: LngLat[], cum: number[], along: number): { point: LngLat; index: number } {
  if (along <= 0) return { point: coords[0], index: 0 };
  const total = cum[cum.length - 1];
  if (along >= total) return { point: coords[coords.length - 1], index: coords.length - 2 };
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= along) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const t = seg > 0 ? (along - cum[lo]) / seg : 0;
  return {
    point: [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t],
    index: lo,
  };
}

/** Simplifica la polilínea para dibujar/consultar (Douglas-Peucker aproximado por distancia mínima) */
export function thin(coords: LngLat[], minMeters: number): LngLat[] {
  if (coords.length < 3) return coords;
  const out: LngLat[] = [coords[0]];
  let last = coords[0];
  for (let i = 1; i < coords.length - 1; i++) {
    if (haversine(last, coords[i]) >= minMeters) {
      out.push(coords[i]);
      last = coords[i];
    }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

export function bbox(coords: LngLat[]): [LngLat, LngLat] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}
