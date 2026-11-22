import { cumulativeDistances, decodePolyline6, haversine, type LngLat } from './geo';
import { loadTimedStreets, streetNames, timeAlong, wrongWays, type DirectedPoint } from './timedStreets';

const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const ELEV_INTERVAL = 200; // m

export interface Maneuver {
  type: number;
  instruction: string;
  /** frase corta para avisar con anticipación ("Gire a la derecha hacia X") */
  alert?: string;
  /** frase justo antes de la maniobra */
  pre?: string;
  post?: string;
  street?: string;
  lengthM: number;
  timeS: number;
  begin: number;
  end: number;
  highway: boolean;
  /** distancia desde el inicio de la ruta hasta el punto de la maniobra */
  alongM: number;
  /** índice de tramo (leg) al que pertenece */
  leg: number;
}

export interface Route {
  coords: LngLat[];
  /** distancia acumulada por vértice (m) */
  cum: number[];
  /** tiempo acumulado por vértice (s) */
  cumT: number[];
  /** velocidad media del tramo [i, i+1] en km/h */
  speed: number[];
  /** elevación interpolada por vértice (m) */
  elev: number[];
  maneuvers: Maneuver[];
  /** índice del último vértice de cada tramo (paradas intermedias) */
  legEnds: number[];
  distanceM: number;
  timeS: number;
  hasToll: boolean;
  hasHighway: boolean;
  /** calles con sentido según la hora: las que se evitaron y las que no se pudo evitar */
  timed?: { avoided: string[]; wrong: string[] };
}

export interface RouteOptions {
  /** velocidad máxima de crucero (km/h) */
  topSpeed?: number;
  /** no usar ningún camino con peaje (plazas ni TAG) */
  excludeTolls?: boolean;
  /** @deprecated planes guardados con la opción antigua: equivale a excludeTolls */
  avoidTolls?: boolean;
  /** puntos (pórticos TAG) por cuya calzada no se debe pasar */
  excludePoints?: LngLat[];
  /** rutas alternativas adicionales (solo con 2 puntos) */
  alternates?: number;
  /**
   * Hora de salida (ms). Con ella se respetan las reglas según la hora: vías exclusivas, calles
   * cerradas los domingos y ferias (las aplica Valhalla) y calles reversibles (las revisa la app).
   */
  departAt?: number;
  /** minutos detenido al final de cada tramo (cargas), para estimar la hora de paso */
  legDelayMin?: number[];
}

/** Límites del servidor público de Valhalla */
const MAX_EXCLUDE_LOCATIONS = 50;
const MAX_EXCLUDE_TRIANGLES = 24; // 100 vértices (cada triángulo cuenta 4 al cerrarse)
export const MAX_EXCLUDE_POINTS = MAX_EXCLUDE_LOCATIONS + MAX_EXCLUDE_TRIANGLES;
/** tramos de calles reversibles que se pueden excluir en un solo sentido por consulta */
const MAX_DIRECTED = 40;

/** "2026-11-23T08:00" en hora local */
function localIso(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Tipos de maniobra de Valhalla que significan llegada */
export const ARRIVE_TYPES = new Set([4, 5, 6]);

export async function getRoute(points: LngLat[], opts: RouteOptions = {}, signal?: AbortSignal): Promise<Route> {
  return (await getRoutes(points, opts, signal))[0];
}

/**
 * Ruta principal + alternativas (si se piden).
 * Con `departAt`, si la ruta va contra el sentido de una calle reversible a la hora de paso, se pide de
 * nuevo excluyendo esos tramos solo en ese sentido (hasta 3 veces). Las alternativas en contra se descartan.
 */
export async function getRoutes(points: LngLat[], opts: RouteOptions = {}, signal?: AbortSignal): Promise<Route[]> {
  const idx = opts.departAt !== undefined ? await loadTimedStreets() : null;
  const directed: DirectedPoint[] = [];
  const avoided = new Set<string>();
  let last: Route[] | null = null;
  let lastWrong: string[] = [];
  for (let round = 0; round < 4; round++) {
    let routes: Route[];
    try {
      routes = await requestRoutes(points, opts, directed, signal);
    } catch (e) {
      // si excluir los tramos deja sin camino, quedarse con la ruta anterior (avisando)
      if (last && (e as Error).name !== 'AbortError') break;
      throw e;
    }
    if (!idx || opts.departAt === undefined) return routes;
    const check = (r: Route) => {
      // cerca del inicio o del final de cada tramo no se excluye (podrías estar estacionado ahí)
      const ends = [0, ...r.legEnds.map((i) => r.cum[i])];
      return wrongWays(r, idx, timeAlong(r, opts.departAt!, opts.legDelayMin)).filter((w) => ends.every((e) => Math.abs(w.alongM - e) > 150));
    };
    const bad = check(routes[0]);
    last = [routes[0], ...routes.slice(1).filter((r) => !check(r).length)];
    lastWrong = streetNames(bad);
    if (!bad.length || directed.length >= MAX_DIRECTED) break;
    for (const b of bad) {
      if (b.way.name) avoided.add(b.way.name);
      if (directed.length < MAX_DIRECTED && !directed.some((d) => haversine(d.p, b.p) < 25 && Math.abs(d.heading - b.heading) < 30)) directed.push({ p: b.p, heading: b.heading });
    }
  }
  const [main, ...alts] = last!;
  const okAvoided = [...avoided].filter((n) => !lastWrong.includes(n));
  main.timed = { avoided: okAvoided, wrong: lastWrong };
  // las alternativas se calcularon con las mismas exclusiones; las que iban en contra ya se descartaron
  for (const a of alts) a.timed = { avoided: okAvoided, wrong: [] };
  return last!;
}

async function requestRoutes(points: LngLat[], opts: RouteOptions, directed: DirectedPoint[], signal?: AbortSignal): Promise<Route[]> {
  const body: Record<string, unknown> = {
    locations: points.map((p) => ({
      lat: +p[1].toFixed(6),
      lon: +p[0].toFixed(6),
      type: 'break',
    })),
    costing: 'auto',
    costing_options: {
      auto: {
        top_speed: Math.round(opts.topSpeed ?? 120),
        ...(opts.excludeTolls || opts.avoidTolls ? { exclude_tolls: true } : {}),
      },
    },
    language: 'es-ES',
    units: 'kilometers',
    elevation_interval: ELEV_INTERVAL,
  };
  if (opts.alternates && points.length === 2) body.alternates = opts.alternates;
  // hora fija (tipo 3): respeta las restricciones según la hora y, a diferencia del tipo 1, permite alternativas
  if (opts.departAt !== undefined) body.date_time = { type: 3, value: localIso(opts.departAt) };
  // tramos de calles reversibles en contra: se excluyen solo en ese sentido (rumbo)
  const dirLocs = directed.slice(0, MAX_DIRECTED).map((d) => ({ lat: +d.p[1].toFixed(6), lon: +d.p[0].toFixed(6), heading: d.heading, heading_tolerance: 35 }));
  const freeLocs = MAX_EXCLUDE_LOCATIONS - dirLocs.length;
  const ex = (opts.excludePoints ?? []).slice(0, freeLocs + MAX_EXCLUDE_TRIANGLES);
  if (ex.length || dirLocs.length) {
    // pórticos: primero como "ubicaciones a evitar" (excluye la calzada más cercana)…
    body.exclude_locations = [...dirLocs, ...ex.slice(0, freeLocs).map((p) => ({ lat: +p[1].toFixed(6), lon: +p[0].toFixed(6) }))];
    // …y el resto como triángulos de ~4 m sobre el pórtico
    const tri = ex.slice(freeLocs).map(([x, y]) => {
      const d = 4 / 111320;
      const e = d / Math.cos((y * Math.PI) / 180);
      return [
        [+(x - e).toFixed(6), +(y - d).toFixed(6)],
        [+(x + e).toFixed(6), +(y - d).toFixed(6)],
        [+x.toFixed(6), +(y + d).toFixed(6)],
      ];
    });
    if (tri.length) body.exclude_polygons = tri;
  }
  const url = `${VALHALLA}?json=${encodeURIComponent(JSON.stringify(body))}`;
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error('Sin conexión con el servicio de rutas. Revisa tu internet e intenta otra vez.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.trip) {
    const msg: string = json?.error ?? '';
    if (/No path could be found|No suitable edges/i.test(msg)) throw new Error('No encontré un camino en auto entre esos puntos.');
    throw new Error('El servicio de rutas no respondió. Intenta de nuevo en unos segundos.');
  }
  const trips = [json.trip, ...((json.alternates ?? []) as { trip: unknown }[]).map((a) => a.trip)].filter(Boolean);
  return trips.map(parseTrip);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseTrip(trip: any): Route {
  const coords: LngLat[] = [];
  const legEnds: number[] = [];
  const maneuvers: Maneuver[] = [];
  const speed: number[] = [];
  const elevSamples: { along: number; h: number }[] = [];
  let legOffsetDist = 0;

  trip.legs.forEach((leg: any, li: number) => {
    const shape = decodePolyline6(leg.shape);
    const base = coords.length === 0 ? 0 : coords.length - 1;
    // evitar duplicar el vértice de unión entre tramos
    if (coords.length) shape.shift();
    coords.push(...shape);

    for (const m of leg.maneuvers) {
      const begin = base + m.begin_shape_index;
      const end = base + m.end_shape_index;
      maneuvers.push({
        type: m.type,
        instruction: m.instruction,
        alert: m.verbal_transition_alert_instruction ?? m.verbal_succinct_transition_instruction,
        pre: m.verbal_pre_transition_instruction ?? m.instruction,
        post: m.verbal_post_transition_instruction,
        street: m.street_names?.[0] ?? m.begin_street_names?.[0],
        lengthM: m.length * 1000,
        timeS: m.time,
        begin,
        end,
        highway: !!m.highway,
        alongM: 0,
        leg: li,
      });
      const v = m.length > 0 && m.time > 0 ? (m.length / m.time) * 3600 : 30;
      for (let k = begin; k < end; k++) speed[k] = v;
    }

    if (Array.isArray(leg.elevation)) {
      const interval = leg.elevation_interval ?? ELEV_INTERVAL;
      leg.elevation.forEach((h: number, k: number) => {
        if (h != null && isFinite(h)) elevSamples.push({ along: legOffsetDist + k * interval, h });
      });
    }
    legOffsetDist += (leg.summary?.length ?? 0) * 1000;
    legEnds.push(coords.length - 1);
  });

  const cum = cumulativeDistances(coords);
  for (let k = 0; k < coords.length - 1; k++) if (!speed[k]) speed[k] = 30;

  // tiempo acumulado (escalado para coincidir con el total de Valhalla)
  const cumT = new Array<number>(coords.length);
  cumT[0] = 0;
  for (let k = 1; k < coords.length; k++) cumT[k] = cumT[k - 1] + (cum[k] - cum[k - 1]) / (speed[k - 1] / 3.6);
  const totalT = trip.summary.time as number;
  const scaleT = cumT[cumT.length - 1] > 0 ? totalT / cumT[cumT.length - 1] : 1;
  for (let k = 0; k < cumT.length; k++) cumT[k] *= scaleT;

  // elevación por vértice
  const totalDist = cum[cum.length - 1];
  const scaleD = legOffsetDist > 0 ? totalDist / legOffsetDist : 1;
  const elev = new Array<number>(coords.length).fill(0);
  if (elevSamples.length > 1) {
    let j = 0;
    for (let k = 0; k < coords.length; k++) {
      const a = cum[k] / scaleD;
      while (j < elevSamples.length - 2 && elevSamples[j + 1].along < a) j++;
      const s0 = elevSamples[j];
      const s1 = elevSamples[j + 1];
      const t = s1.along > s0.along ? Math.max(0, Math.min(1, (a - s0.along) / (s1.along - s0.along))) : 0;
      elev[k] = s0.h + (s1.h - s0.h) * t;
    }
  }

  for (const m of maneuvers) m.alongM = cum[Math.min(m.begin, cum.length - 1)];

  return {
    coords,
    cum,
    cumT,
    speed,
    elev,
    maneuvers,
    legEnds,
    distanceM: totalDist,
    timeS: totalT,
    hasToll: !!trip.summary.has_toll,
    hasHighway: !!trip.summary.has_highway,
  };
}

/** Icono de flecha según el tipo de maniobra de Valhalla */
export function maneuverIcon(type: number): 'straight' | 'right' | 'left' | 'slight-right' | 'slight-left' | 'sharp-right' | 'sharp-left' | 'uturn' | 'roundabout' | 'arrive' | 'depart' | 'merge' | 'exit-right' | 'exit-left' {
  switch (type) {
    case 1:
    case 2:
    case 3:
      return 'depart';
    case 4:
    case 5:
    case 6:
      return 'arrive';
    case 9:
      return 'slight-right';
    case 10:
      return 'right';
    case 11:
      return 'sharp-right';
    case 12:
    case 13:
      return 'uturn';
    case 14:
      return 'sharp-left';
    case 15:
      return 'left';
    case 16:
      return 'slight-left';
    case 18:
    case 20:
    case 23:
      return 'exit-right';
    case 19:
    case 21:
    case 24:
      return 'exit-left';
    case 25:
    case 37:
    case 38:
      return 'merge';
    case 26:
    case 27:
      return 'roundabout';
    default:
      return 'straight';
  }
}
