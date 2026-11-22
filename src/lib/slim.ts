/**
 * Convierte la respuesta de https://cargadorespublicos.cl/api/data (plataforma de
 * interoperabilidad de la SEC) a un formato compacto. Sin imports: lo usa también
 * scripts/snapshot-chargers.ts con Node.
 */

export type ConnStatus = 'DISPONIBLE' | 'OCUPADO' | 'NO DISPONIBLE' | 'FUERA DE LINEA';

export interface SlimConnector {
  /** estándar: "CCS 2", "Tipo 2", "CHAdeMO", ... */
  std: string;
  type: 'AC' | 'DC';
  kw: number;
  status: ConnStatus;
  /** precio energía CLP/kWh si viene informado */
  price?: number;
  /** trae cable propio (CABLE) o es enchufe (SOCKET) */
  cable: boolean;
}

export interface SlimEvse {
  id: string;
  status: ConnStatus;
  connectors: SlimConnector[];
}

export interface SlimStation {
  id: number;
  name: string;
  address: string;
  commune: string;
  region: string;
  lat: number;
  lng: number;
  operator: string;
  open24: boolean;
  /** horario por día ISO (1=lunes..7=domingo) → [inicio, fin] "HH:MM" */
  hours?: Record<number, [string, string]>;
  parking?: string;
  updated: string;
  evses: SlimEvse[];
}

const KEEP_UPPER = new Set(['EDS', 'II', 'III', 'IV', 'SPA', 'S.A.', 'SA', 'ENAP', 'CCS', 'AC', 'DC', 'UC', 'RM', 'BYD', 'GWM']);
const BRANDS: Record<string, string> = {
  'COPEC VOLTEX': 'Copec Voltex',
  'ENEL X': 'Enel X',
  'Enerlink Chile SpA': 'Enerlink',
  'Sin Operador Informado': 'Operador no informado',
  CHILQUINTA: 'Chilquinta',
  'TE MOBILITY': 'TE Mobility',
};

export function niceCase(s: string): string {
  if (!s) return s;
  const letters = s.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '');
  const upperRatio = letters ? letters.replace(/[^A-ZÁÉÍÓÚÑ]/g, '').length / letters.length : 0;
  if (upperRatio < 0.7) return s.trim();
  return s
    .trim()
    .toLowerCase()
    .split(/(\s+|-|\/)/)
    .map((w, i) => {
      if (KEEP_UPPER.has(w.toUpperCase())) return w.toUpperCase();
      if (i > 0 && ['de', 'del', 'la', 'las', 'los', 'y', 'el', 'en'].includes(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
}

function operatorName(l: any): string {
  const raw: string = l?.OPC?.normalized_name || l?.OPC?.name || l?.owner?.name || 'Operador no informado';
  return BRANDS[raw] ?? niceCase(raw);
}

const STATUSES: ConnStatus[] = ['DISPONIBLE', 'OCUPADO', 'NO DISPONIBLE', 'FUERA DE LINEA'];
const normStatus = (s: string): ConnStatus => (STATUSES.includes(s as ConnStatus) ? (s as ConnStatus) : 'FUERA DE LINEA');

export function slimStations(raw: any[]): SlimStation[] {
  const out: SlimStation[] = [];
  for (const l of raw ?? []) {
    const lat = parseFloat(l?.coordinates?.latitude);
    const lng = parseFloat(l?.coordinates?.longitude);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) < 1) continue;
    const op = operatorName(l);
    if (/prueba|test/i.test(op) || /prueba/i.test(l?.name ?? '')) continue;

    const evses: SlimEvse[] = [];
    for (const e of l.evses ?? []) {
      const connectors: SlimConnector[] = [];
      for (const c of e.connectors ?? []) {
        if (!c?.standard || c.standard === 'Favor actualizar valor') continue;
        let price: number | undefined;
        for (const t of c.tariffs ?? []) {
          for (const p of t?.elements?.price_components ?? []) {
            if (p?.tariff_dimension === 'ENERGIA' && p.price > 0) price = p.price;
          }
        }
        connectors.push({
          std: c.standard,
          type: c.power_type === 'DC' ? 'DC' : 'AC',
          kw: Number(c.max_electric_power) || Number(e.max_electric_power) || 0,
          status: normStatus(c.status),
          price,
          cable: c.format === 'CABLE',
        });
      }
      if (connectors.length) evses.push({ id: String(e.evse_id ?? e.evse_uid), status: normStatus(e.status), connectors });
    }
    if (!evses.length) continue;

    let hours: Record<number, [string, string]> | undefined;
    const ot = l.opening_times;
    if (!ot?.twentyfourseven && ot?.regular_hours?.length) {
      hours = {};
      for (const h of ot.regular_hours) hours[h.weekday] = [h.period_begin, h.period_end];
    }

    out.push({
      id: l.location_id,
      name: niceCase(l.name ?? 'Cargador'),
      address: niceCase(l.address ?? ''),
      commune: l.commune ?? '',
      region: l.region ?? '',
      lat,
      lng,
      operator: op,
      open24: !!ot?.twentyfourseven || !hours,
      hours,
      parking: l.parking_type ? niceCase(l.parking_type) : undefined,
      updated: l.last_updated ?? '',
      evses,
    });
  }
  return out;
}
