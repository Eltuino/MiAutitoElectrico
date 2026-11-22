import { haversine, snapToRoute, thin, type LngLat } from './geo';
import { getRoutes, MAX_EXCLUDE_POINTS, type Route } from './routing';
import { tollsOnRoute, type OdSystem, type TollPoint } from './tolls';

/**
 * Tipos de ruta:
 *  - rapida: la de menor tiempo.
 *  - economica: la más barata (peajes + energía) sin alargar demasiado el viaje.
 *  - sintag: sin pórticos TAG (autopistas urbanas / free flow); puede usar plazas con caseta.
 *  - sinpeajes: sin ningún cobro (Valhalla `exclude_tolls`).
 */
export type RoutePref = 'rapida' | 'economica' | 'sintag' | 'sinpeajes';

export const ROUTE_PREFS: Record<RoutePref, { label: string; short: string; sub: string }> = {
  rapida: { label: 'Más rápida', short: 'Rápida', sub: 'El menor tiempo, aunque pague más peajes y TAG.' },
  economica: {
    label: 'Más económica',
    short: 'Económica',
    sub: 'La más barata en peajes, TAG y energía, sin alargar mucho el viaje (máximo ~30 % más de tiempo). Ideal para el día a día.',
  },
  sintag: { label: 'Sin TAG', short: 'Sin TAG', sub: 'Evita autopistas urbanas y pórticos TAG. Puede pasar por plazas de peaje con caseta.' },
  sinpeajes: { label: 'Sin peajes', short: 'Sin peajes', sub: 'Ni pórticos TAG ni plazas de peaje. Puede alargar bastante el viaje.' },
};

/** Cómo reconstruir una ruta (desvío a cargadores, recálculo en el camino) */
export interface RouteSpec {
  excludeTolls?: boolean;
  /** pórticos por cuya calzada no se pasa */
  excludePoints?: LngLat[];
}

export interface RouteOptionInfo {
  key: string;
  distanceM: number;
  timeS: number;
  tollClp: number;
  /** pórticos TAG cobrados */
  tagCount: number;
  energyKwh: number;
  energyClp: number;
  badges: RoutePref[];
  spec: RouteSpec;
  /** geometría simplificada para dibujar */
  preview: LngLat[];
}

export interface RouteOption extends RouteOptionInfo {
  route: Route;
}

/** Minutos de diferencia que valen lo mismo que $30: desempata rutas casi iguales en precio */
const CLP_PER_MIN = 30;
/** La económica no puede tardar más que esto respecto de la más rápida: +30 % +5 min, máximo +30 min */
const ECO_MAX_FACTOR = 0.3;
const ECO_MAX_EXTRA_S = 5 * 60;
const ECO_MAX_TOTAL_S = 30 * 60;

interface Gantry {
  id: string;
  concession: string;
  p: LngLat;
}

function gantriesOf(tolls: TollPoint[], od: OdSystem[]): Gantry[] {
  return [
    ...tolls.filter((t) => t.kind === 'portico').map((t) => ({ id: t.osm, concession: t.concession, p: [t.lng, t.lat] as LngLat })),
    ...od.flatMap((o) => o.gantries.map((g) => ({ id: g.osm, concession: o.concession, p: [g.lng, g.lat] as LngLat }))),
  ];
}

/** Pórticos por los que pasa la ruta (están sobre la calzada: ≈ 0 m de la línea) */
function crossedGantries(route: Route, gantries: Gantry[]): Gantry[] {
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
  const out: Gantry[] = [];
  for (const g of gantries) {
    const [x, y] = g.p;
    if (x < minX - 0.002 || x > maxX + 0.002 || y < minY - 0.002 || y > maxY + 0.002) continue;
    let near = false;
    for (let i = 0; i < route.coords.length; i += 4) {
      if (Math.abs(route.coords[i][1] - y) < 0.01 && Math.abs(route.coords[i][0] - x) < 0.012) {
        near = true;
        break;
      }
    }
    if (near && snapToRoute(g.p, route.coords, route.cum).dist <= 6) out.push(g);
  }
  return out;
}

/**
 * Ruta sin pórticos TAG: Valhalla no distingue TAG de plazas, así que excluimos los pórticos
 * que va cruzando (y sus vecinos de la misma autopista) y volvemos a pedir la ruta, hasta 5 veces.
 */
async function noTagRoute(from: LngLat, to: LngLat, topSpeed: number, departAt: number, first: Route, gantries: Gantry[], signal?: AbortSignal) {
  const ex: Gantry[] = [];
  let route = first;
  for (let round = 0; round < 5; round++) {
    const crossed = crossedGantries(route, gantries);
    if (!crossed.length) break;
    const have = new Set(ex.map((g) => g.id));
    const isCrossed = (g: Gantry) => crossed.some((c) => c.id === g.id);
    const add = gantries
      .filter((g) => !have.has(g.id) && crossed.some((c) => c.id === g.id || (c.concession === g.concession && haversine(c.p, g.p) < 4000)))
      .sort((a, b) => Number(isCrossed(b)) - Number(isCrossed(a)));
    if (!add.length || ex.length >= MAX_EXCLUDE_POINTS) break;
    ex.push(...add.slice(0, MAX_EXCLUDE_POINTS - ex.length));
    route = (await getRoutes([from, to], { topSpeed, departAt, excludePoints: ex.map((g) => g.p) }, signal))[0];
  }
  return { route, points: ex.map((g) => g.p) };
}

function idxAt(cum: number[], along: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= along) lo = mid;
    else hi = mid;
  }
  return lo;
}

function minBy<T>(list: T[], f: (x: T) => number): T | undefined {
  let best: T | undefined;
  let bv = Infinity;
  for (const x of list) {
    const v = f(x);
    if (v < bv) {
      bv = v;
      best = x;
    }
  }
  return best;
}

export interface OptionsInput {
  from: LngLat;
  to: LngLat;
  topSpeed: number;
  pref: RoutePref;
  /** opción elegida a mano (para calcular también la ruta sin TAG si hace falta) */
  key?: string;
  tolls: TollPoint[];
  od: OdSystem[];
  departAt: number;
  /** kWh totales de una ruta */
  energyOf: (r: Route) => number;
  /** $/kWh según cuánta energía necesita (casa o carga rápida) */
  priceFor: (kwh: number) => number;
  /** ¿hay que cargar en el camino con esta energía? */
  needsCharge?: (kwh: number) => boolean;
}

/** Rutas ya pedidas (para cambiar de opción sin volver a consultar el servidor) */
let memo: { sig: string; at: number; list: { key: string; route: Route; spec: RouteSpec }[] } | null = null;

async function candidates(inp: OptionsInput, signal?: AbortSignal) {
  const wantNoTag = inp.pref === 'sintag' || inp.key === 'sintag';
  // el resultado depende de la hora (calles reversibles, vías exclusivas): tramos de 15 min
  const sig = JSON.stringify([inp.from, inp.to, inp.topSpeed, wantNoTag, Math.floor(inp.departAt / 900000)]);
  if (memo && memo.sig === sig && Date.now() - memo.at < 15 * 60000) return memo.list;

  const gantries = gantriesOf(inp.tolls, inp.od);
  const [main, free] = await Promise.all([
    getRoutes([inp.from, inp.to], { topSpeed: inp.topSpeed, departAt: inp.departAt, alternates: 2 }, signal),
    getRoutes([inp.from, inp.to], { topSpeed: inp.topSpeed, departAt: inp.departAt, excludeTolls: true }, signal).catch((e) => {
      if ((e as Error).name === 'AbortError') throw e;
      return [] as Route[];
    }),
  ]);
  const list: { key: string; route: Route; spec: RouteSpec }[] = [{ key: 'rapida', route: main[0], spec: {} }];
  const fastestCross = crossedGantries(main[0], gantries);
  main.slice(1).forEach((r, i) => {
    // para poder rehacer esta alternativa (desvío a cargadores, recálculo): evitar los pórticos
    // de la más rápida por los que ella no pasa
    const mine = new Set(crossedGantries(r, gantries).map((g) => g.id));
    const avoid = fastestCross.filter((g) => !mine.has(g.id)).map((g) => g.p);
    list.push({ key: `alt${i + 1}`, route: r, spec: avoid.length ? { excludePoints: avoid.slice(0, MAX_EXCLUDE_POINTS) } : {} });
  });
  if (free[0]) list.push({ key: 'sinpeajes', route: free[0], spec: { excludeTolls: true } });
  if (wantNoTag) {
    try {
      const nt = await noTagRoute(inp.from, inp.to, inp.topSpeed, inp.departAt, main[0], gantries, signal);
      list.push({ key: 'sintag', route: nt.route, spec: nt.points.length ? { excludePoints: nt.points } : {} });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
    }
  }
  memo = { sig, at: Date.now(), list };
  return list;
}

/** Calcula las rutas posibles con su costo (peajes según la hora + energía) */
export async function routeOptions(inp: OptionsInput, signal?: AbortSignal): Promise<RouteOption[]> {
  let list = await candidates(inp, signal);
  // Con paradas de carga la ruta se rehace pasando por los cargadores: una alternativa sin regla
  // para reconstruirla terminaría siendo la más rápida, así que no se ofrece
  if (inp.needsCharge?.(inp.energyOf(list[0].route))) list = list.filter((c) => c.key === 'rapida' || specRank(c.spec) > 0);
  const opts: RouteOption[] = [];
  for (const c of list) {
    const r = c.route;
    const timeAt = (a: number) => inp.departAt + r.cumT[idxAt(r.cum, a)] * 1000;
    const t = tollsOnRoute(r, inp.tolls, timeAt, inp.od);
    const kwh = inp.energyOf(r);
    const o: RouteOption = {
      key: c.key,
      route: r,
      spec: c.spec,
      distanceM: r.distanceM,
      timeS: r.timeS,
      tollClp: Math.round(t.total),
      tagCount: t.hits.filter((h) => h.toll.kind === 'portico').length,
      energyKwh: kwh,
      energyClp: kwh * inp.priceFor(kwh),
      badges: [],
      preview: thin(r.coords, Math.max(30, r.distanceM / 400)),
    };
    // la misma ruta encontrada por dos caminos: quedarse con una (y con la regla más estricta)
    const dup = opts.find(
      (x) =>
        Math.abs(x.distanceM - o.distanceM) < Math.max(150, o.distanceM * 0.004) &&
        Math.abs(x.timeS - o.timeS) < Math.max(30, o.timeS * 0.01) &&
        Math.abs(x.tollClp - o.tollClp) < 50,
    );
    if (dup) {
      if (specRank(c.spec) > specRank(dup.spec)) dup.spec = c.spec;
      continue;
    }
    opts.push(o);
  }
  const fastest = fastestOf(opts);
  const eco = economic(opts);
  for (const o of opts) {
    if (o === fastest) o.badges.push('rapida');
    if (o === eco) o.badges.push('economica');
    if (o.tollClp === 0) o.badges.push('sinpeajes');
    else if (o.tagCount === 0) o.badges.push('sintag');
  }
  // orden: más rápida primero
  return opts.sort((a, b) => a.timeS - b.timeS);
}

/** Qué tan estricta es la regla para rehacer la ruta: sin peajes > sin TAG > alternativa */
function specRank(s: RouteSpec): number {
  return s.excludeTolls ? 3 : (s.excludePoints?.length ?? 0) > 0 ? 1 : 0;
}

/** La más rápida; si hay varias casi iguales (±1 min), la más barata de ellas */
function fastestOf(opts: RouteOption[]): RouteOption {
  const min = Math.min(...opts.map((o) => o.timeS));
  return minBy(
    opts.filter((o) => o.timeS <= min + 60),
    (o) => o.tollClp + o.energyClp,
  )!;
}

function economic(opts: RouteOption[]): RouteOption {
  const fastest = fastestOf(opts);
  const limit = fastest.timeS + Math.min(fastest.timeS * ECO_MAX_FACTOR + ECO_MAX_EXTRA_S, ECO_MAX_TOTAL_S);
  const pool = opts.filter((o) => o.timeS <= limit);
  return minBy(pool, (o) => o.tollClp + o.energyClp + (o.timeS / 60) * CLP_PER_MIN) ?? fastest;
}

/** Elige la ruta según la preferencia (o la opción elegida a mano) */
export function chooseOption(opts: RouteOption[], pref: RoutePref, key?: string): { option: RouteOption; warning?: string } {
  if (key) {
    const o = opts.find((x) => x.key === key);
    if (o) return { option: o };
  }
  const fastest = fastestOf(opts);
  switch (pref) {
    case 'economica':
      return { option: economic(opts) };
    case 'sinpeajes': {
      const o = minBy(
        opts.filter((x) => x.tollClp === 0),
        (x) => x.timeS,
      );
      return o ? { option: o } : { option: minBy(opts, (x) => x.tollClp)!, warning: 'No encontré un camino sin peajes: te muestro el que paga menos.' };
    }
    case 'sintag': {
      const o = minBy(
        opts.filter((x) => x.tagCount === 0),
        (x) => x.timeS,
      );
      return o ? { option: o } : { option: minBy(opts, (x) => x.tagCount * 1e6 + x.timeS)!, warning: 'No encontré un camino sin ningún pórtico TAG: te muestro el que pasa por menos.' };
    }
    default:
      return { option: fastest };
  }
}

/** Versión liviana para guardar en el plan */
export function optionInfo(o: RouteOption): RouteOptionInfo {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { route, ...info } = o;
  return info;
}

/** Nombre corto de una opción según sus etiquetas */
export function optionTitle(o: Pick<RouteOptionInfo, 'badges' | 'key'>): string {
  if (o.badges.includes('rapida') && o.badges.includes('economica')) return 'Más rápida y económica';
  if (o.badges.includes('rapida')) return 'Más rápida';
  if (o.badges.includes('economica')) return 'Más económica';
  if (o.badges.includes('sinpeajes')) return 'Sin peajes';
  if (o.badges.includes('sintag')) return 'Sin TAG';
  return 'Alternativa';
}
