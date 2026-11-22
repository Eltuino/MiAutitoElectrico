import { create } from 'zustand';
import { slimStations, type ConnStatus, type SlimConnector, type SlimStation } from './slim';
import { haversine, type LngLat } from './geo';

export type { ConnStatus, SlimStation as Station, SlimConnector as Connector };

export const SEC_API = 'https://cargadorespublicos.cl/api/data';
const CACHE_KEY = 'mae.chargers.v1';
const MAX_AGE_MS = 3 * 60 * 1000;

/** ¿El conector sirve para el Ora 5? (CCS 2 en DC, Tipo 2 en AC) */
export const isOra5Compatible = (c: SlimConnector) =>
  (c.type === 'DC' && c.std === 'CCS 2') || (c.type === 'AC' && c.std === 'Tipo 2');

export interface StationSummary {
  /** conectores compatibles con el Ora 5 */
  total: number;
  free: number;
  busy: number;
  down: number;
  offline: number;
  maxDcKw: number;
  maxAcKw: number;
  priceDc?: number;
  priceAc?: number;
  hasDc: boolean;
  /** conectores rápidos (DC) compatibles por estado */
  dcFree: number;
  dcBusy: number;
  dcOffline: number;
  /** minutos que lleva ocupado el conector rápido que lleva más tiempo cargando */
  busyLongestMin?: number;
  /** estimación de minutos hasta que se libere un conector rápido */
  nextFreeMin?: number;
  /** estado general para pintar el pin */
  state: 'free' | 'busy' | 'down' | 'offline';
}

/** Una carga rápida típica dura ~40 min (los datos de la SEC muestran ~41 min de mediana) */
const TYPICAL_DC_SESSION_MIN = 40;

const summaryCache = new WeakMap<SlimStation, StationSummary>();

export function summarize(s: SlimStation): StationSummary {
  const hit = summaryCache.get(s);
  if (hit) return hit;
  const sum: StationSummary = { total: 0, free: 0, busy: 0, down: 0, offline: 0, maxDcKw: 0, maxAcKw: 0, hasDc: false, dcFree: 0, dcBusy: 0, dcOffline: 0, state: 'offline' };
  const dcPrices: number[] = [];
  const acPrices: number[] = [];
  const now = Date.now();
  for (const e of s.evses) {
    const sinceMin = e.since ? Math.max(0, (now - Date.parse(e.since)) / 60000) : undefined;
    for (const c of e.connectors) {
      if (!isOra5Compatible(c)) continue;
      sum.total++;
      if (c.status === 'DISPONIBLE') sum.free++;
      else if (c.status === 'OCUPADO') sum.busy++;
      else if (c.status === 'NO DISPONIBLE') sum.down++;
      else sum.offline++;
      if (c.type === 'DC') {
        if (c.status === 'DISPONIBLE') sum.dcFree++;
        else if (c.status === 'OCUPADO') {
          sum.dcBusy++;
          if (sinceMin !== undefined) sum.busyLongestMin = Math.max(sum.busyLongestMin ?? 0, sinceMin);
        } else if (c.status === 'FUERA DE LINEA') sum.dcOffline++;
        sum.hasDc = true;
        sum.maxDcKw = Math.max(sum.maxDcKw, c.kw);
        if (c.price) dcPrices.push(c.price);
      } else {
        sum.maxAcKw = Math.max(sum.maxAcKw, c.kw);
        if (c.price) acPrices.push(c.price);
      }
    }
  }
  if (dcPrices.length) sum.priceDc = Math.min(...dcPrices);
  if (acPrices.length) sum.priceAc = Math.min(...acPrices);
  sum.state = sum.free > 0 ? 'free' : sum.busy > 0 ? 'busy' : sum.offline > 0 ? 'offline' : 'down';
  if (sum.dcBusy > 0) {
    const b = sum.busyLongestMin;
    // si lleva mucho rato (auto que quedó enchufado) no sabemos: asumimos ~10 min
    sum.nextFreeMin = b === undefined ? 15 : b > TYPICAL_DC_SESSION_MIN + 25 ? 10 : Math.max(3, TYPICAL_DC_SESSION_MIN - b);
  }
  summaryCache.set(s, sum);
  return sum;
}

/**
 * Espera esperada (min) en un cargador rápido si llegas en `etaMin` minutos.
 * - Si llegas pronto, manda el estado en vivo (y cuánto lleva ocupado).
 * - Si llegas en horas, el estado de ahora casi no sirve: usamos el riesgo según
 *   cuántos conectores tiene (más conectores = más probable encontrar uno libre).
 */
export function expectedWaitMin(s: SlimStation, etaMin = 0): number {
  const sum = summarize(s);
  const usable = sum.dcFree + sum.dcBusy + sum.dcOffline;
  if (!sum.hasDc || usable === 0) return Infinity;
  const prior = usable >= 4 ? 1.5 : usable === 3 ? 2.5 : usable === 2 ? 4 : 8;
  const w = Math.exp(-Math.max(0, etaMin) / 40);
  let nowWait: number;
  if (sum.dcFree > 0) nowWait = 0;
  else if (sum.dcBusy > 0) nowWait = Math.max(0, (sum.nextFreeMin ?? 15) - etaMin);
  else nowWait = prior + 6; // sin datos en vivo
  const unknownRisk = sum.dcFree + sum.dcBusy === 0 ? 4 : 0;
  return w * nowWait + (1 - w) * prior + unknownRisk;
}

/** Texto corto del estado de un cargador ocupado: "ocupado hace 35 min · se libera en ~5 min" */
export function busyText(s: SlimStation): string | null {
  const sum = summarize(s);
  if (sum.dcFree > 0 || sum.dcBusy === 0) return null;
  const parts = [];
  if (sum.busyLongestMin !== undefined) parts.push(`ocupado hace ${Math.round(sum.busyLongestMin)} min`);
  if (sum.nextFreeMin !== undefined) parts.push(`se liberaría en ~${Math.round(sum.nextFreeMin)} min`);
  return parts.join(' · ') || null;
}

/** Precios medianos en vivo (CLP/kWh) de todos los cargadores públicos */
export function priceStats(stations: SlimStation[]): { dc?: number; ac?: number } {
  const dc: number[] = [];
  const ac: number[] = [];
  for (const s of stations) {
    const sum = summarize(s);
    if (sum.priceDc) dc.push(sum.priceDc);
    if (sum.priceAc) ac.push(sum.priceAc);
  }
  const med = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : undefined);
  return { dc: med(dc), ac: med(ac) };
}

export const STATE_COLOR: Record<StationSummary['state'], string> = {
  free: '#12B76A',
  busy: '#F59E0B',
  down: '#F04438',
  offline: '#98A2B3',
};

export const STATE_LABEL: Record<StationSummary['state'], string> = {
  free: 'Disponible',
  busy: 'Ocupado',
  down: 'No disponible',
  offline: 'Sin conexión',
};

export const STATUS_LABEL: Record<ConnStatus, string> = {
  DISPONIBLE: 'Disponible',
  OCUPADO: 'Ocupado',
  'NO DISPONIBLE': 'No disponible',
  'FUERA DE LINEA': 'Sin conexión',
};

export const statusBadge = (st: ConnStatus) =>
  st === 'DISPONIBLE' ? 'ok' : st === 'OCUPADO' ? 'warn' : st === 'NO DISPONIBLE' ? 'bad' : 'off';

/** ¿Está abierto ahora? */
export function isOpenNow(s: SlimStation, date = new Date()): boolean {
  if (s.open24 || !s.hours) return true;
  const day = ((date.getDay() + 6) % 7) + 1; // 1=lunes
  const h = s.hours[day];
  if (!h) return false;
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return hm >= h[0] && hm <= h[1];
}

export function hoursText(s: SlimStation, date = new Date()): string {
  if (s.open24 || !s.hours) return 'Abierto 24 horas';
  const day = ((date.getDay() + 6) % 7) + 1;
  const h = s.hours[day];
  if (!h) return 'Cerrado hoy';
  return `Hoy ${h[0]}–${h[1]}`;
}

/** Texto para la voz: "2 de 3 cargadores disponibles" */
export function availabilitySpeech(s: SlimStation): string {
  const sum = summarize(s);
  const dcOnly = s.evses.flatMap((e) => e.connectors).filter((c) => c.type === 'DC' && c.std === 'CCS 2');
  const pool = dcOnly.length ? dcOnly : s.evses.flatMap((e) => e.connectors).filter(isOra5Compatible);
  const free = pool.filter((c) => c.status === 'DISPONIBLE').length;
  if (!pool.length) return '';
  if (sum.state === 'offline' && free === 0) return 'Estado no informado.';
  if (free === 0) return pool.some((c) => c.status === 'OCUPADO') ? 'Todos los cargadores están ocupados.' : 'Los cargadores no están disponibles.';
  return free === 1 ? `1 de ${pool.length} cargadores disponible.` : `${free} de ${pool.length} cargadores disponibles.`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Source = 'live' | 'cache' | 'snapshot' | 'none';

interface ChargersState {
  stations: SlimStation[];
  updatedAt: number;
  source: Source;
  loading: boolean;
  error?: string;
  refresh: (force?: boolean) => Promise<void>;
}

function readCache(): { ts: number; stations: SlimStation[] } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCache(stations: SlimStation[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), stations }));
  } catch {
    /* sin espacio: no pasa nada */
  }
}

const cached = readCache();

export const useChargers = create<ChargersState>((set, get) => ({
  stations: cached?.stations ?? [],
  updatedAt: cached?.ts ?? 0,
  source: cached ? 'cache' : 'none',
  loading: false,
  async refresh(force = false) {
    const st = get();
    if (st.loading) return;
    if (!force && st.source === 'live' && Date.now() - st.updatedAt < MAX_AGE_MS) return;
    set({ loading: true, error: undefined });
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(SEC_API, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const stations = slimStations(await res.json());
      if (!stations.length) throw new Error('Respuesta vacía');
      writeCache(stations);
      set({ stations, updatedAt: Date.now(), source: 'live', loading: false });
    } catch (e: any) {
      if (!get().stations.length) {
        try {
          const snap = await (await fetch(`${import.meta.env.BASE_URL}data/chargers-snapshot.json`)).json();
          set({ stations: snap.stations, updatedAt: snap.ts, source: 'snapshot' });
        } catch {
          /* nada */
        }
      }
      set({ loading: false, error: 'No se pudo actualizar el estado en vivo de los cargadores' });
      console.warn('chargers refresh failed', e);
    }
  },
}));

/** Cargadores cercanos a un punto, ordenados por distancia */
export function nearby(stations: SlimStation[], p: LngLat, radiusM: number, filter?: (s: SlimStation) => boolean) {
  const out: { s: SlimStation; d: number }[] = [];
  for (const s of stations) {
    if (filter && !filter(s)) continue;
    const d = haversine(p, [s.lng, s.lat]);
    if (d <= radiusM) out.push({ s, d });
  }
  return out.sort((a, b) => a.d - b.d);
}

/** Nombre corto para mostrar: quita el operador repetido al inicio */
export function shortName(s: SlimStation): string {
  let n = s.name.replace(/^(copec voltex|copec|enel x)\s*[-–:]\s*/i, '');
  n = n.replace(/^cargador el[eé]ctrico\s*/i, '').replace(/[\s.]+$/, '');
  return n || s.name;
}

// Solo en desarrollo: acceso desde la consola para pruebas
if (import.meta.env.DEV) (window as unknown as { __chargers: typeof useChargers }).__chargers = useChargers;
