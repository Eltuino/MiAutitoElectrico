import { create } from 'zustand';
import type { TripPlan } from '../lib/planner';
import type { Place } from '../lib/places';

const PLAN_KEY = 'mae.plan.v1';
const HIST_KEY = 'mae.history.v1';
const RECENT_KEY = 'mae.recent.v1';

export interface TripRecord {
  id: string;
  date: number;
  from: string;
  to: string;
  distanceKm: number;
  energyKwh: number;
  stops: number;
  costClp: number;
  savedClp: number;
  co2Kg: number;
  totalMin: number;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    if (v === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* sin espacio */
  }
}

/** Redondea arreglos grandes para que el viaje quepa en el almacenamiento local */
export function compactPlan(p: TripPlan): TripPlan {
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    ...p,
    route: {
      ...p.route,
      coords: p.route.coords.map(([x, y]) => [r6(x), r6(y)]),
      cum: p.route.cum.map(r1),
      cumT: p.route.cumT.map(r1),
      speed: p.route.speed.map(r1),
      elev: p.route.elev.map(r1),
    },
    cumKwh: p.cumKwh.map(r3),
    soc: p.soc.map(r1),
  };
}

interface TripState {
  plan?: TripPlan;
  history: TripRecord[];
  recent: Place[];
  setPlan: (p?: TripPlan) => void;
  addHistory: (r: TripRecord) => void;
  addRecent: (p: Place) => void;
}

export const useTrip = create<TripState>((set, get) => ({
  plan: load<TripPlan | undefined>(PLAN_KEY, undefined),
  history: load<TripRecord[]>(HIST_KEY, []),
  recent: load<Place[]>(RECENT_KEY, []),
  setPlan: (plan) => {
    set({ plan });
    save(PLAN_KEY, plan ? compactPlan(plan) : undefined);
  },
  addHistory: (r) => {
    const history = [r, ...get().history.filter((h) => h.id !== r.id)].slice(0, 50);
    set({ history });
    save(HIST_KEY, history);
  },
  addRecent: (p) => {
    if (p.isMe) return;
    const recent = [p, ...get().recent.filter((x) => x.name !== p.name || x.detail !== p.detail)].slice(0, 8);
    set({ recent });
    save(RECENT_KEY, recent);
  },
}));
