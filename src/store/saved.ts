import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Place } from '../lib/places';
import type { RoutePref } from '../lib/routeChoice';
import type { TripPlan } from '../lib/planner';
import { compactPlan } from './trip';

export type SavedKind = 'casa' | 'trabajo' | 'otro';

/** Ruta de siempre: "Trabajo", "Casa", "Donde la abuela"… */
export interface SavedRoute {
  id: string;
  name: string;
  kind: SavedKind;
  destination: Place;
  /** sin origen = sale desde donde estés */
  origin?: Place;
  routePref: RoutePref;
  createdAt: number;
  lastUsed?: number;
}

const planKey = (id: string) => `mae.saved.plan.${id}`;

/** Guarda el último cálculo de la ruta para poder partir sin internet */
export function cachePlanFor(id: string, plan: TripPlan) {
  try {
    localStorage.setItem(planKey(id), JSON.stringify({ at: Date.now(), plan: compactPlan(plan) }));
  } catch {
    /* sin espacio: no es grave */
  }
}

export function cachedPlanFor(id: string): { at: number; plan: TripPlan } | null {
  try {
    const raw = localStorage.getItem(planKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

interface SavedState {
  routes: SavedRoute[];
  save: (r: Omit<SavedRoute, 'id' | 'createdAt'> & { id?: string }) => SavedRoute;
  remove: (id: string) => void;
  touch: (id: string) => void;
}

export const useSaved = create<SavedState>()(
  persist(
    (set, get) => ({
      routes: [],
      save: (r) => {
        const existing = r.id ? get().routes.find((x) => x.id === r.id) : get().routes.find((x) => x.name.toLowerCase() === r.name.toLowerCase());
        const route: SavedRoute = { ...existing, ...r, id: existing?.id ?? Math.random().toString(36).slice(2, 10), createdAt: existing?.createdAt ?? Date.now() };
        // casa y trabajo primero
        const order = { casa: 0, trabajo: 1, otro: 2 } as const;
        const routes = [...get().routes.filter((x) => x.id !== route.id), route].sort((a, b) => order[a.kind] - order[b.kind] || a.createdAt - b.createdAt);
        set({ routes });
        return route;
      },
      remove: (id) => {
        set({ routes: get().routes.filter((x) => x.id !== id) });
        try {
          localStorage.removeItem(planKey(id));
        } catch {
          /* nada */
        }
      },
      touch: (id) => set({ routes: get().routes.map((x) => (x.id === id ? { ...x, lastUsed: Date.now() } : x)) }),
    }),
    { name: 'mae.saved.v1' },
  ),
);
