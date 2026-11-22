import { billedKwh, chargeMinutes, chargePowerAt, ORA5 } from './car';
import { expectedWaitMin, summarize, type Station } from './chargers';
import { routeEnergy, kwhPerKm, type Conditions } from './energy';
import { snapToRoute, thin, bbox, type LngLat } from './geo';
import { getRoute, type Route } from './routing';
import type { Place } from './places';
import { MODE_INFO, type TripMode } from '../store/settings';
import { tollsOnRoute, type OdSystem, type TollHit, type TollPoint } from './tolls';
import { chooseOption, optionInfo, routeOptions, type RouteOptionInfo, type RoutePref, type RouteSpec } from './routeChoice';

export interface PlanInput {
  origin: Place;
  destination: Place;
  startSoc: number;
  arrivalMin: number;
  mode: TripMode;
  cruiseKmh: number;
  passengers: number;
  cargoKg: number;
  climateOn: boolean;
  /** tipo de ruta: rápida, económica, sin TAG o sin peajes */
  routePref?: RoutePref;
  /** opción de ruta elegida a mano en el resultado ('rapida', 'alt1', 'sinpeajes'…) */
  routeKey?: string;
  /** @deprecated planes antiguos: equivale a routePref 'sinpeajes' */
  avoidTolls?: boolean;
  calibration: number;
  usableKwh: number;
  tempOrigin: number;
  tempDest: number;
  priceDc: number;
  /** $/kWh cargando en casa (para comparar rutas cortas) */
  priceHome?: number;
  gasPrice: number;
  gasKmPerL: number;
  /** hora de salida (ms); por defecto ahora */
  departAt?: number;
}

export interface PlannedStop {
  station: Station;
  /** distancia desde el origen hasta el desvío (m) */
  alongM: number;
  detourM: number;
  arriveSoc: number;
  departSoc: number;
  chargeMin: number;
  /** potencia efectiva del cargador (kW) */
  kw: number;
  costClp: number;
  /** kWh que se pagan en esta parada (para recalcular el costo con el precio en vivo) */
  kwh: number;
  /** minutos desde la salida hasta llegar a la parada */
  etaMin: number;
  /** espera esperada al llegar (min), según estado en vivo y tamaño de la estación */
  waitMin: number;
  /** cargadores rápidos alternativos cerca de esta parada (plan B) */
  alternates: RouteCharger[];
}

export interface RouteCharger {
  station: Station;
  alongM: number;
  offsetM: number;
}

/**
 * Plan B de una parada: otros cargadores rápidos cerca, alcanzables con la batería prevista.
 * `alongM` aquí es relativo a la parada: negativo = antes, positivo = después.
 */
function alternatesFor(stop: Candidate, cands: Candidate[], arriveSoc: number, input: PlanInput): RouteCharger[] {
  const kwhPerM = kwhPerKm(105, { cruiseKmh: 105, passengers: input.passengers, cargoKg: input.cargoKg, tempC: input.tempOrigin, climateOn: input.climateOn, calibration: input.calibration }) / 1000;
  return cands
    .filter((c) => c.station.id !== stop.station.id && c.kw >= 40)
    .map((c) => ({ c, delta: c.alongM - stop.alongM }))
    .filter(({ delta }) => delta > -30000 && delta < 30000)
    // si queda después de la parada, hay que llegar con al menos 5 %
    .filter(({ delta, c }) => delta <= 0 || arriveSoc - ((delta + c.detourM / 2) * kwhPerM * 1.1 / input.usableKwh) * 100 >= 5)
    .sort((a, b) => a.c.penaltyMin + Math.abs(a.delta) / 2000 - (b.c.penaltyMin + Math.abs(b.delta) / 2000))
    .slice(0, 3)
    .map(({ c, delta }) => ({ station: c.station, alongM: delta, offsetM: c.offsetM }));
}

export interface TripPlan {
  id: string;
  createdAt: number;
  input: PlanInput;
  route: Route;
  /** kWh acumulados por vértice de `route` */
  cumKwh: number[];
  /** % batería estimado por vértice (incluye cargas en paradas) */
  soc: number[];
  stops: PlannedStop[];
  /** cargadores compatibles a lo largo de la ruta (para avisos) */
  routeChargers: RouteCharger[];
  /** peajes y pórticos TAG que cruza la ruta */
  tolls?: TollHit[];
  /** rutas posibles (rápida, económica, sin peajes…) para elegir */
  routeOptions?: RouteOptionInfo[];
  /** opción usada */
  routeKey?: string;
  /** cómo rehacer la ruta al recalcular en el camino */
  routeSpec?: RouteSpec;
  totals: {
    distanceM: number;
    driveMin: number;
    chargeMin: number;
    totalMin: number;
    energyKwh: number;
    arriveSoc: number;
    costClp: number;
    /** peajes + TAG (CLP, autos) */
    tollClp?: number;
    gasCostClp: number;
    co2SavedKg: number;
    kwhPer100: number;
  };
  warnings: string[];
  feasible: boolean;
}

interface Candidate {
  station: Station;
  idx: number; // vértice de la ruta más cercano
  alongM: number;
  offsetM: number;
  detourM: number;
  kw: number;
  penaltyMin: number;
}

const STOP_OVERHEAD_MIN = 5;
/** margen de energía al elegir paradas (el desvío real y el tráfico suelen sumar) */
const SAFETY = 1.04;

function chargerPower(s: Station): number {
  const sum = summarize(s);
  return Math.min(sum.maxDcKw || 50, ORA5.dcMaxKw);
}

/** Tabla de minutos acumulados de carga 0→s% para una potencia (búsqueda O(1)) */
function chargeTable(kw: number, tempC: number, cap: number): Float64Array {
  const t = new Float64Array(201); // pasos de 0,5 %
  for (let i = 1; i <= 200; i++) {
    const s = (i - 0.5) / 2;
    t[i] = t[i - 1] + ((0.5 / 100) * cap) / chargePowerAt(s, kw, 'DC', tempC) * 60;
  }
  return t;
}
const tIdx = (soc: number) => Math.max(0, Math.min(200, Math.round(soc * 2)));

function findCandidates(route: Route, stations: Station[], maxOffsetM: number): Candidate[] {
  const thinIdx: number[] = [0];
  for (let i = 1; i < route.coords.length; i++) {
    if (route.cum[i] - route.cum[thinIdx[thinIdx.length - 1]] >= 150 || i === route.coords.length - 1) thinIdx.push(i);
  }
  const tCoords = thinIdx.map((i) => route.coords[i]);
  const tCum = thinIdx.map((i) => route.cum[i]);
  const [[minX, minY], [maxX, maxY]] = bbox(tCoords);
  const pad = 0.06;
  const out: Candidate[] = [];
  for (const s of stations) {
    if (s.lng < minX - pad || s.lng > maxX + pad || s.lat < minY - pad || s.lat > maxY + pad) continue;
    const sum = summarize(s);
    if (!sum.hasDc || sum.maxDcKw < 20) continue;
    if (sum.state === 'down') continue; // todos sus conectores fuera de servicio
    const snap = snapToRoute([s.lng, s.lat], tCoords, tCum);
    if (snap.dist > maxOffsetM) continue;
    const idx = thinIdx[Math.min(snap.index + (snap.t > 0.5 ? 1 : 0), thinIdx.length - 1)];
    const detourM = snap.dist * 1.4 * 2;
    // espera esperada a la hora en que llegaríamos (el manejo + ~12 % por cargas previas)
    const etaMin = (route.cumT[idx] / 60) * 1.12;
    const penaltyMin = expectedWaitMin(s, etaMin);
    if (!isFinite(penaltyMin)) continue;
    out.push({ station: s, idx, alongM: route.cum[idx], offsetM: snap.dist, detourM, kw: chargerPower(s), penaltyMin });
  }
  return out.sort((a, b) => a.alongM - b.alongM);
}

interface Label {
  cost: number;
  prevNode: number;
  prevSoc: number;
  departSoc: number;
  chargeMin: number;
}

/**
 * Elige las paradas que minimizan el tiempo total (manejo + carga + desvíos + riesgo de espera).
 * Estados: (nodo, % de llegada). Se carga "lo justo" para llegar al siguiente nodo con la reserva.
 */
function optimize(route: Route, cumKwh: number[], cands: Candidate[], input: PlanInput, tempAt: (f: number) => number) {
  const mode = MODE_INFO[input.mode];
  const cap = input.usableKwh;
  const nodes = [
    { idx: 0, alongM: 0, detourM: 0, kw: 0, penaltyMin: 0, station: null as Station | null },
    ...cands.map((c) => ({ ...c, station: c.station as Station | null })),
    { idx: route.coords.length - 1, alongM: route.distanceM, detourM: 0, kw: 0, penaltyMin: 0, station: null as Station | null },
  ];
  const N = nodes.length;
  const end = N - 1;
  const detourKwh = (n: (typeof nodes)[number]) =>
    n.detourM * kwhPerKm(40, { cruiseKmh: 40, passengers: input.passengers, cargoKg: input.cargoKg, tempC: 20, climateOn: input.climateOn, calibration: input.calibration }) / 1000;
  const detourMin = (n: (typeof nodes)[number]) => (n.detourM / 1000 / 35) * 60;

  const tables = new Map<number, Float64Array>();
  const tableFor = (kw: number, f: number) => {
    const key = Math.round(kw / 5) * 5 * 1000 + Math.round(tempAt(f));
    let t = tables.get(key);
    if (!t) {
      t = chargeTable(Math.round(kw / 5) * 5, tempAt(f), cap);
      tables.set(key, t);
    }
    return t;
  };

  const labels: Map<number, Label>[] = Array.from({ length: N }, () => new Map());
  const startSoc = Math.round(input.startSoc);
  labels[0].set(startSoc, { cost: 0, prevNode: -1, prevSoc: -1, departSoc: startSoc, chargeMin: 0 });
  const maxSpanKwh = ((mode.maxCharge - Math.min(mode.stopReserve, input.arrivalMin)) / 100) * cap * 1.05;

  for (let i = 0; i < N - 1; i++) {
    const from = nodes[i];
    if (!labels[i].size) continue;
    const table = i > 0 ? tableFor(from.kw, from.alongM / route.distanceM) : null;
    for (const [arrSoc, lab] of labels[i]) {
      for (let j = i + 1; j < N; j++) {
        const to = nodes[j];
        const legKwh = (cumKwh[to.idx] - cumKwh[from.idx] + detourKwh(from) / 2 + detourKwh(to) / 2) * SAFETY;
        if (legKwh > maxSpanKwh && i > 0) break;
        const reserve = j === end ? input.arrivalMin : mode.stopReserve;
        const needSoc = reserve + (legKwh / cap) * 100;
        let depart = arrSoc;
        let chMin = 0;
        if (i === 0) {
          if (needSoc > startSoc + 1e-9) {
            if ((legKwh / cap) * 100 > startSoc) break; // ni siquiera llega
            continue;
          }
        } else {
          if (needSoc <= arrSoc) continue; // no hace falta parar aquí
          depart = Math.ceil(needSoc);
          if (depart > mode.maxCharge) {
            // ¿cabe con 100 %? solo si el modo lo permite (no). Probar siguientes nodos más cercanos ya se hizo.
            continue;
          }
          chMin = table![tIdx(depart)] - table![tIdx(arrSoc)] + 1 + STOP_OVERHEAD_MIN + from.penaltyMin + detourMin(from);
        }
        const driveMin = (route.cumT[to.idx] - route.cumT[from.idx]) / 60;
        const arrive = Math.round(depart - (legKwh / cap) * 100);
        // cada parada "molesta": preferimos menos paradas aunque cada una sea algo más larga
        const stopPenalty = i > 0 ? mode.stopPenalty : 0;
        const cost = lab.cost + driveMin + chMin + stopPenalty;
        const prev = labels[j].get(arrive);
        if (!prev || cost < prev.cost) {
          labels[j].set(arrive, { cost, prevNode: i, prevSoc: arrSoc, departSoc: depart, chargeMin: chMin });
        }
      }
    }
  }

  // Mejor llegada al destino
  let best: { soc: number; lab: Label } | null = null;
  for (const [soc, lab] of labels[end]) if (!best || lab.cost < best.lab.cost) best = { soc, lab };
  if (!best) return null;

  // Reconstruir paradas
  const chain: { node: number; arriveSoc: number; departSoc: number }[] = [];
  let lab: Label | undefined = best.lab;
  while (lab && lab.prevNode > 0) {
    chain.unshift({ node: lab.prevNode, arriveSoc: lab.prevSoc, departSoc: lab.departSoc });
    lab = labels[lab.prevNode].get(lab.prevSoc);
  }
  return chain.map((c) => ({ cand: nodes[c.node] as Candidate, arriveSoc: c.arriveSoc, departSoc: c.departSoc }));
}

function tempInterp(input: PlanInput) {
  return (f: number) => input.tempOrigin + (input.tempDest - input.tempOrigin) * Math.max(0, Math.min(1, f));
}

function conditions(input: PlanInput): Conditions {
  return {
    cruiseKmh: input.cruiseKmh,
    passengers: input.passengers,
    cargoKg: input.cargoKg,
    tempC: input.tempOrigin,
    climateOn: input.climateOn,
    climateFactor: MODE_INFO[input.mode].climateFactor,
    calibration: input.calibration,
  };
}

/** Cargadores compatibles a menos de `maxOffsetM` de la ruta, con su posición a lo largo */
export function chargersAlong(route: Route, stations: Station[], maxOffsetM = 900): RouteCharger[] {
  const thinIdx: number[] = [0];
  for (let i = 1; i < route.coords.length; i++) {
    if (route.cum[i] - route.cum[thinIdx[thinIdx.length - 1]] >= 100 || i === route.coords.length - 1) thinIdx.push(i);
  }
  const tCoords = thinIdx.map((i) => route.coords[i]);
  const tCum = thinIdx.map((i) => route.cum[i]);
  const [[minX, minY], [maxX, maxY]] = bbox(tCoords);
  const out: RouteCharger[] = [];
  for (const s of stations) {
    if (s.lng < minX - 0.02 || s.lng > maxX + 0.02 || s.lat < minY - 0.02 || s.lat > maxY + 0.02) continue;
    const sum = summarize(s);
    if (!sum.total) continue;
    const snap = snapToRoute([s.lng, s.lat], tCoords, tCum);
    if (snap.dist <= maxOffsetM) out.push({ station: s, alongM: snap.along, offsetM: snap.dist });
  }
  return out.sort((a, b) => a.alongM - b.alongM);
}

export async function planTrip(input: PlanInput, stations: Station[], signal?: AbortSignal, tollList: TollPoint[] = [], odList: OdSystem[] = []): Promise<TripPlan> {
  const cond = conditions(input);
  const tempAt = tempInterp(input);
  const warnings: string[] = [];

  // 1) Rutas posibles (rápida, alternativas, sin peajes, sin TAG) y la elegida
  const pref: RoutePref = input.routePref ?? (input.avoidTolls ? 'sinpeajes' : 'rapida');
  const departAt = input.departAt ?? Date.now();
  const options = await routeOptions(
    {
      from: input.origin.lngLat,
      to: input.destination.lngLat,
      topSpeed: input.cruiseKmh,
      pref,
      key: input.routeKey,
      tolls: tollList,
      od: odList,
      departAt,
      energyOf: (r) => {
        const k = routeEnergy(r, cond, tempAt);
        return k[k.length - 1];
      },
      // si alcanza con la batería se compara con lo que cuesta cargar en casa; si no, con carga rápida
      priceFor: (kwh) => ((kwh / input.usableKwh) * 100 > input.startSoc - input.arrivalMin ? input.priceDc : input.priceHome ?? 190),
      needsCharge: (kwh) => (kwh / input.usableKwh) * 100 > input.startSoc - input.arrivalMin,
    },
    signal,
  );
  const choice = chooseOption(options, pref, input.routeKey);
  if (choice.warning) warnings.push(choice.warning);
  const spec = choice.option.spec;
  const direct = choice.option.route;
  const directKwh = routeEnergy(direct, cond, tempAt);
  const needDirect = (directKwh[directKwh.length - 1] / input.usableKwh) * 100;

  let route = direct;
  let cumKwh = directKwh;
  let stopsRaw: { cand: Candidate; arriveSoc: number; departSoc: number }[] = [];
  let candList: Candidate[] = [];
  let feasible = true;

  if (input.startSoc - needDirect < input.arrivalMin) {
    // 2) Hace falta cargar: buscar cargadores cerca de la ruta
    let cands = findCandidates(direct, stations, 3000);
    let chain = optimize(direct, directKwh, cands, input, tempAt);
    if (!chain) {
      cands = findCandidates(direct, stations, 9000);
      chain = optimize(direct, directKwh, cands, input, tempAt);
      if (chain) warnings.push('Algunas paradas quedan a varios km de la ruta principal.');
    }
    if (!chain) {
      // relajar reserva en paradas
      const relaxed = { ...input, mode: 'rapido' as TripMode };
      chain = optimize(direct, directKwh, cands, relaxed, tempAt);
      if (chain) warnings.push('Para llegar tuve que usar reservas más bajas que las de tu modo elegido.');
    }
    if (!chain) {
      feasible = false;
      warnings.push('No encontré una combinación de cargadores públicos para completar este viaje con la batería indicada. Prueba saliendo con más carga o bajando la velocidad.');
    } else {
      stopsRaw = chain;
      candList = cands;
      // 3) Ruta pasando por las paradas
      if (chain.length) {
        const pts: LngLat[] = [input.origin.lngLat, ...chain.map((c) => [c.cand.station.lng, c.cand.station.lat] as LngLat), input.destination.lngLat];
        try {
          // tiempo detenido en cada parada (para saber a qué hora pasas por calles con horario)
          const legDelayMin = chain.map((c) => chargeMinutes(c.arriveSoc, c.departSoc, c.cand.kw, 'DC', tempAt(c.cand.alongM / direct.distanceM), input.usableKwh) + STOP_OVERHEAD_MIN);
          route = await getRoute(pts, { topSpeed: input.cruiseKmh, ...spec, departAt, legDelayMin }, signal);
          cumKwh = routeEnergy(route, cond, tempAt);
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw e;
          warnings.push('No pude trazar el desvío exacto a cada cargador; muestro la ruta directa.');
        }
      }
    }
  }

  // 4) Perfil de batería sobre la ruta final
  const cap = input.usableKwh;
  const soc = new Array<number>(route.coords.length);
  const stops: PlannedStop[] = [];
  const viaStops = route !== direct && stopsRaw.length === route.legEnds.length - 1;
  const stopIdx = viaStops
    ? route.legEnds.slice(0, -1)
    : stopsRaw.map((s) => s.cand.idx);
  let k = 0;
  let base = input.startSoc;
  let baseKwh = 0;
  let extraMin = 0;
  for (let i = 0; i < route.coords.length; i++) {
    soc[i] = base - ((cumKwh[i] - baseKwh) / cap) * 100;
    if (k < stopsRaw.length && i === stopIdx[k]) {
      const raw = stopsRaw[k];
      const arrive = soc[i];
      const depart = Math.max(raw.departSoc, Math.ceil(arrive));
      const f = route.cum[i] / route.distanceM;
      const chMin = chargeMinutes(Math.max(0, arrive), depart, raw.cand.kw, 'DC', tempAt(f), cap);
      const price = summarize(raw.cand.station).priceDc ?? input.priceDc;
      stops.push({
        station: raw.cand.station,
        alongM: route.cum[i],
        detourM: raw.cand.detourM,
        arriveSoc: arrive,
        departSoc: depart,
        chargeMin: chMin,
        kw: raw.cand.kw,
        costClp: billedKwh(Math.max(0, arrive), depart, 'DC', cap) * price,
        kwh: billedKwh(Math.max(0, arrive), depart, 'DC', cap),
        etaMin: route.cumT[i] / 60 + extraMin,
        waitMin: expectedWaitMin(raw.cand.station, route.cumT[i] / 60 + extraMin),
        alternates: alternatesFor(raw.cand, candList, arrive, input),
      });
      extraMin += chMin + STOP_OVERHEAD_MIN;
      base = depart;
      baseKwh = cumKwh[i];
      soc[i] = depart;
      k++;
    }
  }

  if (route.timed?.wrong.length)
    warnings.push(`Ojo: a la hora en que pasarías, ${route.timed.wrong.join(', ')} ${route.timed.wrong.length === 1 ? 'tiene' : 'tienen'} otro sentido de tránsito y no encontré cómo evitarla. Respeta la señalización.`);

  const arriveSoc = soc[soc.length - 1];
  if (feasible && arriveSoc < input.arrivalMin - 3) warnings.push(`Llegarías con ${Math.round(arriveSoc)} %, bajo tu mínimo de ${input.arrivalMin} %.`);
  if (Math.min(...soc) < 3) {
    feasible = false;
    if (!warnings.length) warnings.push('La batería no alcanza para este tramo.');
  }

  const energyKwh = cumKwh[cumKwh.length - 1];
  const driveMin = route.timeS / 60;
  const chargeMin = stops.reduce((a, s) => a + s.chargeMin + STOP_OVERHEAD_MIN, 0);
  const gasL = route.distanceM / 1000 / input.gasKmPerL;
  const costClp = stops.reduce((a, s) => a + s.costClp, 0);
  const tempMax = Math.max(input.tempOrigin, input.tempDest);
  const tempMin = Math.min(input.tempOrigin, input.tempDest);
  if (tempMin < 5) warnings.push('Hace frío: la batería rinde menos y la carga rápida será más lenta.');
  if (tempMax > 30 && input.climateOn) warnings.push('Hace calor: el aire acondicionado sumará consumo.');
  if (input.mode === 'eco' && stops.some((s) => s.departSoc > 80)) warnings.push('Alguna parada necesita cargar sobre 80 %.');

  // Peajes: hora de paso = salida + manejo + cargas hechas antes de ese punto
  const timeAt = (alongM: number) => {
    let lo = 0;
    let hi = route.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (route.cum[mid] <= alongM) lo = mid;
      else hi = mid;
    }
    const chargeBefore = stops.filter((s) => s.alongM < alongM).reduce((a, s) => a + s.chargeMin + STOP_OVERHEAD_MIN, 0);
    return departAt + route.cumT[lo] * 1000 + chargeBefore * 60000;
  };
  const tollHits = tollsOnRoute(route, tollList, timeAt, odList);

  return {
    id: Math.random().toString(36).slice(2),
    createdAt: Date.now(),
    input,
    route,
    cumKwh,
    soc,
    stops,
    routeChargers: chargersAlong(route, stations),
    tolls: tollHits.hits,
    routeOptions: options.map(optionInfo),
    routeKey: choice.option.key,
    routeSpec: spec,
    totals: {
      distanceM: route.distanceM,
      driveMin,
      chargeMin,
      totalMin: driveMin + chargeMin,
      energyKwh,
      arriveSoc,
      costClp,
      gasCostClp: gasL * input.gasPrice,
      co2SavedKg: gasL * 2.31,
      kwhPer100: (energyKwh / (route.distanceM / 1000)) * 100,
      tollClp: tollHits.total,
    },
    warnings,
    feasible,
  };
}

/**
 * Link de Google Maps con las paradas como waypoints.
 * `from = 'here'` (o un origen "Mi ubicación") deja que Google Maps parta desde tu GPS.
 */
export function googleMapsUrl(plan: TripPlan, from?: LngLat | 'here'): string {
  const d = plan.input.destination.lngLat;
  const wps = plan.stops.map((s) => `${s.station.lat},${s.station.lng}`).join('|');
  const p = new URLSearchParams({ api: '1' });
  const o = from === 'here' ? null : from ?? (plan.input.origin.isMe ? null : plan.input.origin.lngLat);
  if (o) p.set('origin', `${o[1]},${o[0]}`);
  p.set('destination', `${d[1]},${d[0]}`);
  p.set('travelmode', 'driving');
  // si el viaje evita peajes, Google Maps también (para que vayan por el mismo camino)
  if (plan.input.routePref === 'sinpeajes' || plan.input.avoidTolls) p.set('avoid', 'tolls');
  if (wps) p.set('waypoints', wps);
  return `https://www.google.com/maps/dir/?${p.toString()}`;
}

export function wazeUrl(p: LngLat): string {
  return `https://waze.com/ul?ll=${p[1]},${p[0]}&navigate=yes`;
}

export function thinRoute(route: Route, m = 30) {
  return thin(route.coords, m);
}
