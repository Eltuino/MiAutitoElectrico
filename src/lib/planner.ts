import { billedKwh, chargeMinutes, chargePowerAt, ORA5 } from './car';
import { summarize, type Station } from './chargers';
import { routeEnergy, kwhPerKm, type Conditions } from './energy';
import { snapToRoute, thin, bbox, type LngLat } from './geo';
import { getRoute, type Route } from './routing';
import type { Place } from './places';
import { MODE_INFO, type TripMode } from '../store/settings';

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
  avoidTolls: boolean;
  calibration: number;
  usableKwh: number;
  tempOrigin: number;
  tempDest: number;
  priceDc: number;
  gasPrice: number;
  gasKmPerL: number;
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
  /** minutos desde la salida hasta llegar a la parada */
  etaMin: number;
}

export interface RouteCharger {
  station: Station;
  alongM: number;
  offsetM: number;
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
  totals: {
    distanceM: number;
    driveMin: number;
    chargeMin: number;
    totalMin: number;
    energyKwh: number;
    arriveSoc: number;
    costClp: number;
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
    const penaltyMin = sum.free > 0 ? 0 : sum.busy > 0 ? 12 : 6;
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

export async function planTrip(input: PlanInput, stations: Station[], signal?: AbortSignal): Promise<TripPlan> {
  const cond = conditions(input);
  const tempAt = tempInterp(input);
  const warnings: string[] = [];

  // 1) Ruta directa
  const direct = await getRoute([input.origin.lngLat, input.destination.lngLat], { topSpeed: input.cruiseKmh, avoidTolls: input.avoidTolls }, signal);
  const directKwh = routeEnergy(direct, cond, tempAt);
  const needDirect = (directKwh[directKwh.length - 1] / input.usableKwh) * 100;

  let route = direct;
  let cumKwh = directKwh;
  let stopsRaw: { cand: Candidate; arriveSoc: number; departSoc: number }[] = [];
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
      // 3) Ruta pasando por las paradas
      if (chain.length) {
        const pts: LngLat[] = [input.origin.lngLat, ...chain.map((c) => [c.cand.station.lng, c.cand.station.lat] as LngLat), input.destination.lngLat];
        try {
          route = await getRoute(pts, { topSpeed: input.cruiseKmh, avoidTolls: input.avoidTolls }, signal);
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
        etaMin: route.cumT[i] / 60 + extraMin,
      });
      extraMin += chMin + STOP_OVERHEAD_MIN;
      base = depart;
      baseKwh = cumKwh[i];
      soc[i] = depart;
      k++;
    }
  }

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

  return {
    id: Math.random().toString(36).slice(2),
    createdAt: Date.now(),
    input,
    route,
    cumKwh,
    soc,
    stops,
    routeChargers: chargersAlong(route, stations),
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
    },
    warnings,
    feasible,
  };
}

/** Link de Google Maps con las paradas como waypoints */
export function googleMapsUrl(plan: TripPlan, from?: LngLat): string {
  const o = from ?? plan.input.origin.lngLat;
  const d = plan.input.destination.lngLat;
  const wps = plan.stops.map((s) => `${s.station.lat},${s.station.lng}`).join('|');
  const p = new URLSearchParams({
    api: '1',
    origin: `${o[1]},${o[0]}`,
    destination: `${d[1]},${d[0]}`,
    travelmode: 'driving',
  });
  if (wps) p.set('waypoints', wps);
  return `https://www.google.com/maps/dir/?${p.toString()}`;
}

export function wazeUrl(p: LngLat): string {
  return `https://waze.com/ul?ll=${p[1]},${p[0]}&navigate=yes`;
}

export function thinRoute(route: Route, m = 30) {
  return thin(route.coords, m);
}
