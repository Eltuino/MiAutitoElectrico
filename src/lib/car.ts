/**
 * Ficha técnica del GWM Ora 5 Deluxe (ficha oficial GWM Chile, FUM 11/2026)
 * + datos de calibración que no vienen en la ficha (marcados como estimados).
 */
export const ORA5 = {
  model: 'GWM Ora 5 Deluxe',
  batteryKwh: 58.3, // ficha
  usableKwh: 56.5, // estimado (≈97 % útil)
  powerHp: 201, // ficha
  torqueNm: 260, // ficha
  zeroTo100: 7.7, // s, ficha
  rangeWltpKm: 435, // ficha
  rangeNedcKm: 520, // ficha
  wltpKmPerKwh: 7.5, // ficha (13,3 kWh/100 km)
  dcMaxKw: 120, // ficha, CCS Tipo 2
  acMaxKw: 6.6, // ficha
  portableKw: 2, // cargador de viaje incluido
  connector: 'CCS 2',
  curbKg: 1700, // estimado (fuentes: 1.669–1.760 kg)
  lengthMm: 4471,
  widthMm: 1833,
  heightMm: 1641,
  wheelbaseMm: 2720,
  trunkL: 362,
  tyres: '225/60 R18',
  // Aerodinámica estimada para el cálculo de consumo
  cd: 0.3,
  frontalAreaM2: 2.5,
  crr: 0.0095,
} as const;

export type CarColorKey = 'marfil' | 'gris-metal' | 'gris-mate' | 'verde' | 'turquesa' | 'magenta';

export interface CarColor {
  key: CarColorKey;
  name: string;
  hex: string;
  /** pintura mate (sin barniz brillante) */
  matte?: boolean;
}

/** Colores oficiales del Ora 5 en Chile (ficha técnica) */
export const CAR_COLORS: CarColor[] = [
  { key: 'marfil', name: 'Blanco marfil', hex: '#EEEAE0' },
  { key: 'gris-metal', name: 'Gris metalizado', hex: '#B4B8BE' },
  { key: 'gris-mate', name: 'Gris mate', hex: '#5F646C', matte: true },
  { key: 'verde', name: 'Verde oscuro', hex: '#1D5643' },
  { key: 'turquesa', name: 'Azul turquesa', hex: '#169FAE' },
  { key: 'magenta', name: 'Rosa magenta', hex: '#D3256E' },
];

export const colorByKey = (k: CarColorKey) => CAR_COLORS.find((c) => c.key === k) ?? CAR_COLORS[0];

/**
 * Curva de carga rápida DC estimada (potencia que acepta la batería según % de carga).
 * Calibrada para coincidir con lo publicado: 30→80 % ≈ 20 min y 10→80 % ≈ 30 min con 120 kW.
 */
const DC_CURVE: [number, number][] = [
  [0, 55],
  [5, 72],
  [10, 85],
  [20, 105],
  [30, 118],
  [40, 118],
  [50, 105],
  [60, 92],
  [70, 78],
  [80, 55],
  [85, 40],
  [90, 28],
  [95, 15],
  [100, 4],
];

function interp(curve: [number, number][], x: number) {
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (x <= curve[i][0]) {
      const [x0, y0] = curve[i - 1];
      const [x1, y1] = curve[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}

export type PowerType = 'AC' | 'DC';

/** Factor por temperatura de batería: en frío la carga DC es más lenta */
export function tempChargeFactor(tempC: number, type: PowerType) {
  if (type === 'AC') return tempC < 0 ? 0.9 : 1;
  if (tempC >= 15) return 1;
  if (tempC <= -5) return 0.45;
  return 0.45 + ((tempC + 5) / 20) * 0.55;
}

/**
 * Potencia real (kW, lado batería) que entra al auto a un % dado.
 * @param chargerKw potencia máxima del cargador
 */
export function chargePowerAt(soc: number, chargerKw: number, type: PowerType, tempC = 20): number {
  if (type === 'AC') {
    const maxAc = Math.min(chargerKw, ORA5.acMaxKw) * 0.92; // pérdidas del cargador a bordo
    const taper = soc < 95 ? 1 : Math.max(0.25, 1 - (soc - 95) / 6);
    return maxAc * taper * tempChargeFactor(tempC, 'AC');
  }
  const carKw = interp(DC_CURVE, soc) * tempChargeFactor(tempC, 'DC');
  return Math.max(1, Math.min(carKw, Math.min(chargerKw, ORA5.dcMaxKw) * 0.96));
}

/** Minutos para cargar de `from` a `to` % (integración numérica de la curva). */
export function chargeMinutes(
  from: number,
  to: number,
  chargerKw: number,
  type: PowerType,
  tempC = 20,
  capacityKwh: number = ORA5.usableKwh,
): number {
  if (to <= from) return 0;
  const step = 0.5;
  let minutes = 0;
  for (let s = from; s < to; s += step) {
    const ds = Math.min(step, to - s);
    const kwh = (ds / 100) * capacityKwh;
    minutes += (kwh / chargePowerAt(s + ds / 2, chargerKw, type, tempC)) * 60;
  }
  // ~1 min de conexión / handshake en DC
  return minutes + (type === 'DC' ? 1 : 0.5);
}

/** % de batería alcanzado después de `minutes` minutos de carga, partiendo de `from`. */
export function socAfterMinutes(
  from: number,
  minutes: number,
  chargerKw: number,
  type: PowerType,
  tempC = 20,
  capacityKwh: number = ORA5.usableKwh,
): number {
  let t = minutes - (type === 'DC' ? 1 : 0.5);
  let s = from;
  if (t <= 0) return from;
  const step = 0.25;
  while (s < 100 && t > 0) {
    const kwh = (step / 100) * capacityKwh;
    const dt = (kwh / chargePowerAt(s + step / 2, chargerKw, type, tempC)) * 60;
    if (dt > t) {
      s += step * (t / dt);
      t = 0;
    } else {
      s += step;
      t -= dt;
    }
  }
  return Math.min(100, s);
}

/** kWh que se pagan en el cargador (incluye pérdidas de carga) */
export function billedKwh(fromSoc: number, toSoc: number, type: PowerType, capacityKwh: number = ORA5.usableKwh) {
  const intoBattery = (Math.max(0, toSoc - fromSoc) / 100) * capacityKwh;
  return intoBattery / (type === 'DC' ? 0.95 : 0.9);
}
