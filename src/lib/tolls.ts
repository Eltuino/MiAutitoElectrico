import { haversine, snapToRoute, type LngLat } from './geo';
import type { Route } from './routing';

/**
 * Peajes y pórticos TAG de Chile.
 * Precios: tarifas oficiales 2026 del MOP (Dirección General de Concesiones) para
 * "Autos y camionetas". Ubicaciones: OpenStreetMap. Archivo: public/data/tolls.json
 */

export interface TollBand {
  /** "1-5" = lunes a viernes, "6-7" = fin de semana, "1-7" = todos */
  days: string;
  from: string;
  to: string;
}

export interface TollPoint {
  osm: string;
  lat: number;
  lng: number;
  name: string;
  concession: string;
  road?: string;
  kind: 'troncal' | 'lateral' | 'portico';
  /** CLP, tarifa normal / fuera de punta */
  price: number;
  pricePeak?: number;
  priceSat?: number;
  peak?: TollBand[];
  sat?: TollBand[];
  /** la tarifa punta rige solo en temporada alta (20 dic–marzo) y fines de semana largos */
  seasonal?: boolean;
  confidence?: string;
}

/** Autopistas que cobran por tramo entrada→salida (ej. AVO), no por pórtico */
export interface OdSystem {
  concession: string;
  road?: string;
  gantries: { osm: string; lat: number; lng: number; portico: string; roles: string[] }[];
  pairs: { entry: string; exit: string; tbfp: number; tbp: number; km?: number }[];
  perKm: { tbfp: number; tbp: number };
  peak?: TollBand[];
}

export interface TollData {
  updated: string;
  source: string;
  tolls: TollPoint[];
  od?: OdSystem[];
}

export interface TollHit {
  toll: TollPoint;
  /** distancia desde el inicio de la ruta (m) */
  alongM: number;
  /** hora estimada de paso */
  at: number;
  price: number;
  band: 'normal' | 'punta' | 'saturación';
}

let cache: Promise<TollData | null> | null = null;

export function loadTolls(): Promise<TollData | null> {
  if (!cache) {
    cache = fetch(`${import.meta.env.BASE_URL}data/tolls.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return cache;
}

function inDays(spec: string, isoDay: number): boolean {
  return spec.split(',').some((part) => {
    const [a, b] = part.split('-').map((x) => parseInt(x, 10));
    return b ? isoDay >= a && isoDay <= b : isoDay === a;
  });
}

function inBands(bands: TollBand[] | undefined, at: Date): boolean {
  if (!bands?.length) return false;
  const isoDay = ((at.getDay() + 6) % 7) + 1;
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return bands.some((b) => inDays(b.days, isoDay) && hm >= b.from && hm < b.to);
}

/** Tarifa que corresponde a una hora */
export function tollPriceAt(t: TollPoint, at: Date): { price: number; band: TollHit['band'] } {
  if (t.priceSat && inBands(t.sat, at)) return { price: t.priceSat, band: 'saturación' };
  if (t.pricePeak && inBands(t.peak, at)) return { price: t.pricePeak, band: 'punta' };
  return { price: t.price, band: 'normal' };
}

/**
 * Peajes que cruza la ruta. Valhalla sigue la geometría de OpenStreetMap, así que un peaje
 * sobre la calzada que recorremos es un vértice de la ruta (≈ 0 m). El de la calzada
 * contraria o el de una salida (lateral) queda más lejos y no se cobra.
 * `timeAt(alongM)` devuelve la hora estimada de paso.
 */
export function tollsOnRoute(route: Route, tolls: TollPoint[], timeAt: (alongM: number) => number, od: OdSystem[] = []): { hits: TollHit[]; total: number } {
  if ((!tolls.length && !od.length) || route.coords.length < 2) return { hits: [], total: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of route.coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = 0.002;
  const raw: TollHit[] = [];
  for (const t of tolls) {
    if (t.lng < minX - pad || t.lng > maxX + pad || t.lat < minY - pad || t.lat > maxY + pad) continue;
    const p: LngLat = [t.lng, t.lat];
    // filtro rápido: ¿algún vértice cerca?
    let near = false;
    for (let i = 0; i < route.coords.length; i += 4) {
      if (Math.abs(route.coords[i][1] - t.lat) < 0.01 && Math.abs(route.coords[i][0] - t.lng) < 0.012) {
        near = true;
        break;
      }
    }
    if (!near) continue;
    const snap = snapToRoute(p, route.coords, route.cum);
    // Los nodos por los que pasamos quedan a ~0 m (son vértices de la ruta). Los del sentido
    // contrario quedan a 15–30 m y los de salidas laterales a 9–14 m: por eso la tolerancia es mínima.
    const isWayCenter = t.osm.startsWith('way/');
    const maxDist = isWayCenter ? 40 : 4;
    if (snap.dist > maxDist) continue;
    const at = timeAt(snap.along);
    const { price, band } = tollPriceAt(t, new Date(at));
    raw.push({ toll: t, alongM: snap.along, at, price, band });
  }
  // Tramos con cobro entrada→salida (AVO): precio exacto del par o, si falta un pórtico en el mapa, por km
  for (const sys of od) {
    const crossed: { g: OdSystem['gantries'][number]; along: number }[] = [];
    for (const g of sys.gantries) {
      if (g.lng < minX - pad || g.lng > maxX + pad || g.lat < minY - pad || g.lat > maxY + pad) continue;
      const s = snapToRoute([g.lng, g.lat], route.coords, route.cum);
      if (s.dist <= 4) crossed.push({ g, along: s.along });
    }
    if (!crossed.length) continue;
    crossed.sort((a, b) => a.along - b.along);
    const entry = crossed.find((c) => c.g.roles.some((r) => r.startsWith('entrada'))) ?? crossed[0];
    const exit = [...crossed].reverse().find((c) => c.g.roles.some((r) => r.startsWith('salida'))) ?? crossed[crossed.length - 1];
    const at = timeAt(entry.along);
    const peak = inBands(sys.peak, new Date(at));
    const pair = sys.pairs.find((x) => x.entry === entry.g.portico && x.exit === exit.g.portico);
    const km = Math.max(1.5, (exit.along - entry.along) / 1000 + 1);
    const price = pair ? (peak ? pair.tbp : pair.tbfp) : Math.round(km * (peak ? sys.perKm.tbp : sys.perKm.tbfp));
    raw.push({
      toll: { osm: `od/${sys.concession}`, lat: entry.g.lat, lng: entry.g.lng, name: sys.concession, concession: sys.concession, road: sys.road, kind: 'portico', price, confidence: pair ? undefined : 'media' },
      alongM: entry.along,
      at,
      price,
      band: peak ? 'punta' : 'normal',
    });
  }

  raw.sort((a, b) => a.alongM - b.alongM);
  // una misma plaza puede tener varios puntos (pistas, sentidos): cobrar una vez cada 1,5 km
  const hits: TollHit[] = [];
  for (const h of raw) {
    const dup = hits.find(
      (x) =>
        (x.toll.name === h.toll.name || haversine([x.toll.lng, x.toll.lat], [h.toll.lng, h.toll.lat]) < 150) &&
        x.toll.concession === h.toll.concession &&
        Math.abs(x.alongM - h.alongM) < 1500,
    );
    if (!dup) hits.push(h);
  }
  return { hits, total: hits.reduce((a, h) => a + h.price, 0) };
}

/** Agrupa pórticos urbanos por autopista para mostrarlos resumidos */
export function groupHits(hits: TollHit[]) {
  const groups: { key: string; title: string; kind: TollPoint['kind']; count: number; total: number; hits: TollHit[]; band: TollHit['band'] }[] = [];
  for (const h of hits) {
    if (h.toll.kind === 'portico') {
      const last = groups[groups.length - 1];
      if (last && last.kind === 'portico' && last.title === h.toll.concession) {
        last.count++;
        last.total += h.price;
        last.hits.push(h);
        if (h.band !== 'normal') last.band = h.band;
        continue;
      }
      groups.push({ key: `${h.toll.osm}`, title: h.toll.concession, kind: 'portico', count: 1, total: h.price, hits: [h], band: h.band });
    } else {
      groups.push({ key: h.toll.osm, title: h.toll.name, kind: h.toll.kind, count: 1, total: h.price, hits: [h], band: h.band });
    }
  }
  return groups;
}
