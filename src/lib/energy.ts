import { ORA5 } from './car';
import type { Route } from './routing';

/**
 * Modelo físico de consumo del Ora 5 (lado batería).
 * Resistencia a la rodadura + aerodinámica + pendientes + ciclos de aceleración + climatización.
 * Calibrado para dar ≈13–14 kWh/100 km en ciclo mixto tipo WLTP (homologado: 7,5 km/kWh).
 */
export interface Conditions {
  /** velocidad máxima de crucero (km/h) */
  cruiseKmh: number;
  passengers: number;
  cargoKg: number;
  tempC: number;
  climateOn: boolean;
  /** 0.75 en modo eco (clima más suave) */
  climateFactor?: number;
  calibration: number;
}

const G = 9.81;
const DRIVE_EFF = 0.9;
const REGEN_EFF = 0.65;
const AUX_BASE_KW = 0.35;

export function massKg(c: Pick<Conditions, 'passengers' | 'cargoKg'>) {
  return ORA5.curbKg + c.passengers * 75 + c.cargoKg;
}

/** Potencia de climatización (kW) según temperatura exterior */
export function climateKw(tempC: number, on: boolean, factor = 1): number {
  if (!on) return 0;
  let kw = 0;
  if (tempC < 18) kw = Math.min(2.6, 0.13 * (18 - tempC));
  else if (tempC > 23) kw = Math.min(1.8, 0.35 + 0.1 * (tempC - 23));
  return kw * factor;
}

/** Penalización por batería fría */
export function coldFactor(tempC: number) {
  return tempC >= 15 ? 1 : 1 + Math.min(0.25, (15 - tempC) * 0.008);
}

/** kWh por km en plano a velocidad constante `kmh` */
export function kwhPerKm(kmh: number, c: Conditions): number {
  const v = Math.max(3, kmh) / 3.6;
  const m = massKg(c);
  const rho = (1.225 * 288.15) / (273.15 + c.tempC);
  const fRoll = m * G * ORA5.crr;
  const fAero = 0.5 * rho * ORA5.cd * ORA5.frontalAreaM2 * v * v;
  const wheel = (fRoll + fAero) / 3.6e6 / DRIVE_EFF; // kWh/m → por km abajo
  const dyn = 0.075 * Math.max(0, 1 - kmh / 110) * (m / 1775);
  const aux = (AUX_BASE_KW + climateKw(c.tempC, c.climateOn, c.climateFactor)) / Math.max(5, kmh);
  return (wheel * 1000 + dyn + aux) * coldFactor(c.tempC) * c.calibration;
}

/** Energía (kWh) de un tramo con desnivel */
export function segmentKwh(distM: number, kmh: number, dElevM: number, c: Conditions): number {
  let e = kwhPerKm(kmh, c) * (distM / 1000);
  const pot = (massKg(c) * G * dElevM) / 3.6e6;
  e += pot > 0 ? pot / DRIVE_EFF : pot * REGEN_EFF;
  return e;
}

/**
 * Perfil de energía acumulada (kWh) por vértice de la ruta.
 * `tempAt(fraction)` permite variar la temperatura a lo largo del viaje.
 */
export function routeEnergy(route: Route, c: Conditions, tempAt?: (f: number) => number): number[] {
  const n = route.coords.length;
  const out = new Array<number>(n);
  out[0] = 0;
  const total = route.distanceM || 1;
  let cond = c;
  for (let i = 1; i < n; i++) {
    if (tempAt && i % 50 === 1) cond = { ...c, tempC: tempAt(route.cum[i] / total) };
    const d = route.cum[i] - route.cum[i - 1];
    const v = Math.min(route.speed[i - 1] ?? 50, c.cruiseKmh);
    out[i] = out[i - 1] + segmentKwh(d, v, route.elev[i] - route.elev[i - 1], cond);
  }
  return out;
}

/** Autonomía estimada (km) con un % de batería dado en condiciones típicas de carretera/mixtas */
export function estimateRangeKm(soc: number, c: Conditions, usableKwh: number, kind: 'mixto' | 'carretera' | 'ciudad' = 'mixto') {
  const kwhKm =
    kind === 'carretera' ? kwhPerKm(Math.min(c.cruiseKmh, 110), c) : kind === 'ciudad' ? kwhPerKm(32, c) : 0.5 * kwhPerKm(100, c) + 0.5 * kwhPerKm(40, c);
  return ((soc / 100) * usableKwh) / kwhKm;
}
