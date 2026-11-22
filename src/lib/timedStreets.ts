import { bearing, type LngLat } from './geo';
import type { Route } from './routing';

/**
 * Calles cuyo sentido cambia según la hora (reversibles, ej. Cristóbal Colón o Irarrázaval en la
 * mañana). Vienen de OpenStreetMap (`oneway:conditional`) en public/data/timed-streets.json.
 * Valhalla no las respeta, así que revisamos cada ruta y, si va contra el sentido a la hora de paso,
 * se vuelve a pedir excluyendo esos tramos solo en ese sentido (exclude_locations con rumbo).
 */

export type Dir = 'yes' | '-1' | 'no';

export interface TimedRule {
  /** sentido permitido mientras rige la regla: yes = el de la vía, -1 = el contrario, no = ambos */
  v: Dir;
  /** días ISO (1 = lunes … 7 = domingo) */
  d: number[];
  /** tramos horarios en minutos desde medianoche */
  t: [number, number][];
}

export interface TimedWay {
  id: number;
  name?: string;
  /** sentido cuando no rige ninguna regla */
  base: Dir;
  rules: TimedRule[];
  c: LngLat[];
}

interface Index {
  ways: TimedWay[];
  grid: Map<string, { w: number; i: number }[]>;
}

/** Punto a excluir en un solo sentido */
export interface DirectedPoint {
  p: LngLat;
  heading: number;
}

export interface WrongWay extends DirectedPoint {
  way: TimedWay;
  alongM: number;
}

const CELL = 0.0005; // ≈ 50 m
const cellKey = (x: number, y: number) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

function buildIndex(ways: TimedWay[]): Index {
  const grid = new Map<string, { w: number; i: number }[]>();
  ways.forEach((way, w) =>
    way.c.forEach(([x, y], i) => {
      const k = cellKey(x, y);
      const list = grid.get(k);
      if (list) list.push({ w, i });
      else grid.set(k, [{ w, i }]);
    }),
  );
  return { ways, grid };
}

let cache: Promise<Index | null> | null = null;

export function loadTimedStreets(): Promise<Index | null> {
  if (!cache) {
    const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
    cache = fetch(`${base}data/timed-streets.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j?.ways ? buildIndex(j.ways) : null))
      .catch(() => null);
  }
  return cache;
}

/** Para pruebas fuera del navegador */
export function setTimedStreets(ways: TimedWay[]) {
  cache = Promise.resolve(buildIndex(ways));
}

/** Sentido permitido en una vía a una hora */
export function directionAt(w: TimedWay, at: Date): Dir {
  const day = ((at.getDay() + 6) % 7) + 1;
  const min = at.getHours() * 60 + at.getMinutes();
  for (const r of w.rules) {
    if (!r.d.includes(day)) continue;
    if (r.t.some(([a, b]) => (a <= b ? min >= a && min < b : min >= a || min < b))) return r.v;
  }
  return w.base;
}

/**
 * ¿el vértice de la ruta es un nodo de una vía con horario? Valhalla pasa exacto por los nodos de OSM
 * (mismas coordenadas a 6 decimales), así que la tolerancia es mínima y, si dos nodos de la misma vía
 * quedan casi encima (pasa en esquinas), se toma solo el más cercano.
 */
function nodesAt(idx: Index, p: LngLat): { w: number; i: number }[] {
  const best = new Map<number, { i: number; d: number }>();
  const cx = Math.floor(p[0] / CELL);
  const cy = Math.floor(p[1] / CELL);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const list = idx.grid.get(`${cx + dx}:${cy + dy}`);
      if (!list) continue;
      for (const h of list) {
        const q = idx.ways[h.w].c[h.i];
        const d = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
        if (d > 0.000004) continue; // ~0,4 m
        const cur = best.get(h.w);
        if (!cur || d < cur.d) best.set(h.w, { i: h.i, d });
      }
    }
  return [...best].map(([w, { i }]) => ({ w, i }));
}

/**
 * Tramos de la ruta que van contra el sentido permitido a la hora en que pasarías.
 * Devuelve un punto (con el rumbo de avance) cada ~130 m del tramo en contra, para excluirlo.
 */
export function wrongWays(route: Route, idx: Index, timeAt: (alongM: number) => number): WrongWay[] {
  const out: WrongWay[] = [];
  const lastAt = new Map<number, number>();
  let prev: { w: number; i: number }[] = [];
  for (let k = 0; k < route.coords.length; k++) {
    const hits = nodesAt(idx, route.coords[k]);
    for (const h of hits) {
      // nodos seguidos de la misma vía (o saltándose uno, por si la forma omitió un punto repetido)
      const ph = prev.find((x) => x.w === h.w && Math.abs(x.i - h.i) >= 1 && Math.abs(x.i - h.i) <= 2);
      if (!ph) continue;
      const way = idx.ways[h.w];
      const forward = h.i > ph.i;
      const allowed = directionAt(way, new Date(timeAt(route.cum[k])));
      if ((allowed === 'yes' && forward) || (allowed === '-1' && !forward) || allowed === 'no') continue;
      const along = route.cum[k];
      if (along - (lastAt.get(way.id) ?? -Infinity) < 130) continue;
      lastAt.set(way.id, along);
      const a = route.coords[k - 1];
      const b = route.coords[k];
      out.push({ way, alongM: along, p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], heading: Math.round(bearing(a, b)) });
    }
    prev = hits;
  }
  return out;
}

/** Hora de paso por cada punto de una ruta (salida + manejo + cargas en los tramos anteriores) */
export function timeAlong(route: Route, departAt: number, legDelayMin: number[] = []): (alongM: number) => number {
  return (alongM) => {
    let lo = 0;
    let hi = route.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (route.cum[mid] <= alongM) lo = mid;
      else hi = mid;
    }
    let delay = 0;
    route.legEnds.forEach((end, li) => {
      if (end <= lo && li < route.legEnds.length - 1) delay += legDelayMin[li] ?? 0;
    });
    return departAt + route.cumT[lo] * 1000 + delay * 60000;
  };
}

/** Nombres de calle únicos (para mostrar) */
export function streetNames(list: { way: TimedWay }[]): string[] {
  return [...new Set(list.map((x) => x.way.name).filter(Boolean) as string[])];
}
