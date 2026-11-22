import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { chargeMinutes, socAfterMinutes, type PowerType } from '../lib/car';

export interface ChargeSession {
  startedAt: number;
  startSoc: number;
  targetSoc: number;
  kw: number;
  type: PowerType;
  tempC: number;
  /** CLP por kWh */
  price: number;
  stationName?: string;
  /** % en los que avisar (además del objetivo) */
  milestones: number[];
  notified: number[];
  capacityKwh: number;
  finishedAt?: number;
}

interface TimerState {
  session?: ChargeSession;
  start: (s: Omit<ChargeSession, 'startedAt' | 'notified'>) => void;
  /** El usuario corrige el % real que muestra el auto: re-ancla la curva desde ahora */
  correct: (soc: number) => void;
  markNotified: (pct: number) => void;
  finish: () => void;
  clear: () => void;
}

export const useTimer = create<TimerState>()(
  persist(
    (set, get) => ({
      session: undefined,
      start: (s) => set({ session: { ...s, startedAt: Date.now(), notified: [] } }),
      correct: (soc) => {
        const s = get().session;
        if (!s) return;
        set({ session: { ...s, startSoc: soc, startedAt: Date.now() - (s.type === 'DC' ? 60000 : 30000), notified: s.notified.filter((n) => n <= soc) } });
      },
      markNotified: (pct) => {
        const s = get().session;
        if (s && !s.notified.includes(pct)) set({ session: { ...s, notified: [...s.notified, pct] } });
      },
      finish: () => {
        const s = get().session;
        if (s) set({ session: { ...s, finishedAt: Date.now() } });
      },
      clear: () => set({ session: undefined }),
    }),
    {
      name: 'mae.timer.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ session: s.session }),
    },
  ),
);

/** Estado calculado de una sesión en un instante */
export function sessionState(s: ChargeSession, now = Date.now()) {
  const elapsedMin = ((s.finishedAt ?? now) - s.startedAt) / 60000;
  const soc = Math.min(s.targetSoc, socAfterMinutes(s.startSoc, elapsedMin, s.kw, s.type, s.tempC, s.capacityKwh));
  const totalMin = chargeMinutes(s.startSoc, s.targetSoc, s.kw, s.type, s.tempC, s.capacityKwh);
  const remainingMin = Math.max(0, totalMin - elapsedMin);
  const kwhAdded = ((soc - s.startSoc) / 100) * s.capacityKwh;
  const billed = kwhAdded / (s.type === 'DC' ? 0.95 : 0.9);
  return {
    elapsedMin,
    soc,
    totalMin,
    remainingMin,
    etaAt: s.startedAt + totalMin * 60000,
    kwhAdded,
    cost: billed * s.price,
    done: soc >= s.targetSoc - 0.05 || remainingMin <= 0,
    /** minuto (desde el inicio) en que se alcanza cada % */
    minuteFor: (pct: number) => chargeMinutes(s.startSoc, pct, s.kw, s.type, s.tempC, s.capacityKwh),
  };
}
