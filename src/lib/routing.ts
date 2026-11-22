import { cumulativeDistances, decodePolyline6, type LngLat } from './geo';

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
}

export interface RouteOptions {
  /** velocidad máxima de crucero (km/h) */
  topSpeed?: number;
  avoidTolls?: boolean;
}

/** Tipos de maniobra de Valhalla que significan llegada */
export const ARRIVE_TYPES = new Set([4, 5, 6]);

export async function getRoute(points: LngLat[], opts: RouteOptions = {}, signal?: AbortSignal): Promise<Route> {
  const body = {
    locations: points.map((p, i) => ({
      lat: +p[1].toFixed(6),
      lon: +p[0].toFixed(6),
      type: i === 0 || i === points.length - 1 ? 'break' : 'break',
    })),
    costing: 'auto',
    costing_options: {
      auto: {
        top_speed: Math.round(opts.topSpeed ?? 120),
        use_tolls: opts.avoidTolls ? 0 : 0.5,
      },
    },
    language: 'es-ES',
    units: 'kilometers',
    elevation_interval: ELEV_INTERVAL,
  };
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

  const coords: LngLat[] = [];
  const legEnds: number[] = [];
  const maneuvers: Maneuver[] = [];
  const speed: number[] = [];
  const elevSamples: { along: number; h: number }[] = [];
  let legOffsetDist = 0;

  json.trip.legs.forEach((leg: any, li: number) => {
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
  const totalT = json.trip.summary.time as number;
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
    hasToll: !!json.trip.summary.has_toll,
    hasHighway: !!json.trip.summary.has_highway,
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
