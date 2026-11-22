import type { Route, Maneuver } from './routing';
import type { TripPlan, RouteCharger, PlannedStop } from './planner';
import { routeEnergy, type Conditions } from './energy';
import { MODE_INFO } from '../store/settings';
import { availabilitySpeech, shortName, summarize, type Station } from './chargers';
import { speakDistance } from './format';

/** Condiciones de consumo usadas por un plan */
export function planConditions(plan: TripPlan): Conditions {
  const i = plan.input;
  return {
    cruiseKmh: i.cruiseKmh,
    passengers: i.passengers,
    cargoKg: i.cargoKg,
    tempC: (i.tempOrigin + i.tempDest) / 2,
    climateOn: i.climateOn,
    climateFactor: MODE_INFO[i.mode].climateFactor,
    calibration: i.calibration,
  };
}

/** Perfil de % de batería para una ruta que pasa por paradas (en los fines de tramo) */
export function socProfile(route: Route, cumKwh: number[], startSoc: number, departs: number[], cap: number): number[] {
  const soc = new Array<number>(route.coords.length);
  let base = startSoc;
  let baseKwh = 0;
  let k = 0;
  for (let i = 0; i < route.coords.length; i++) {
    soc[i] = base - ((cumKwh[i] - baseKwh) / cap) * 100;
    if (k < departs.length && i === route.legEnds[k]) {
      base = Math.max(soc[i], departs[k]);
      baseKwh = cumKwh[i];
      soc[i] = base;
      k++;
    }
  }
  return soc;
}

export interface NavRoute {
  route: Route;
  soc: number[];
  /** paradas restantes en esta ruta (en orden) con su posición */
  stops: (PlannedStop & { navAlong: number })[];
  chargers: RouteCharger[];
}

export function navFromPlan(plan: TripPlan): NavRoute {
  return {
    route: plan.route,
    soc: plan.soc,
    stops: plan.stops.map((s) => ({ ...s, navAlong: s.alongM })),
    chargers: plan.routeChargers,
  };
}

export function rebuildNav(plan: TripPlan, route: Route, currentSoc: number, remaining: PlannedStop[], chargers: RouteCharger[]): NavRoute {
  const cumKwh = routeEnergy(route, planConditions(plan));
  const soc = socProfile(route, cumKwh, currentSoc, remaining.map((s) => s.departSoc), plan.input.usableKwh);
  const stops = remaining.map((s, i) => ({ ...s, navAlong: route.cum[route.legEnds[i]] ?? s.alongM }));
  return { route, soc, stops, chargers };
}

/** Nombre hablado de un cargador: "Copec Voltex Aeropuerto La Araucanía" */
export function spokenName(s: Station): string {
  const short = shortName(s);
  if (/no informado/i.test(s.operator)) return /cargador|copec|enel|shell|enex/i.test(short) ? short : `Cargador ${short}`;
  return short.toLowerCase().includes(s.operator.toLowerCase()) ? short : `${s.operator}, ${short}`;
}

export function chargerAlertText(s: Station, distM: number, stopNumber?: number, arriveSoc?: number): string {
  const avail = availabilitySpeech(s);
  if (stopNumber) {
    const extra = arriveSoc !== undefined ? ` Llegarás con ${Math.round(arriveSoc)} por ciento.` : '';
    return `Tu parada de carga ${stopNumber}, ${spokenName(s)}, está a ${speakDistance(distM)}. ${avail}${extra}`;
  }
  return `${spokenName(s)} a ${speakDistance(distM)}. ${avail}`;
}

/** Umbrales (m) para anunciar una maniobra según la velocidad */
export function maneuverThresholds(speedKmh: number) {
  const v = Math.max(20, speedKmh) / 3.6;
  if (speedKmh >= 75) return { far: 1500, near: Math.max(250, v * 9) };
  return { far: 400, near: Math.max(70, v * 6.5) };
}

export function farText(m: Maneuver, distM: number): string {
  const what = m.alert || m.pre || m.instruction;
  return `En ${speakDistance(distM)}, ${lowerFirst(what)}`;
}

function lowerFirst(s: string) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

export function isFastCharger(s: Station) {
  const sum = summarize(s);
  return sum.hasDc && sum.maxDcKw >= 40;
}
