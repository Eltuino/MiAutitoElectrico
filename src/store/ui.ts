import { create } from 'zustand';
import type { Station } from '../lib/chargers';

export type Tab = 'home' | 'trip' | 'chargers' | 'timer' | 'settings';

export interface TimerPrefill {
  startSoc?: number;
  targetSoc?: number;
  kw?: number;
  type?: 'AC' | 'DC';
  price?: number;
  stationName?: string;
  autoStart?: boolean;
}

interface UiState {
  tab: Tab;
  navigating: boolean;
  timerPrefill?: TimerPrefill;
  focusStation?: Station;
  toast?: { text: string; id: number };
  go: (tab: Tab) => void;
  setNavigating: (v: boolean) => void;
  openTimer: (p: TimerPrefill) => void;
  clearTimerPrefill: () => void;
  showStation: (s: Station) => void;
  clearFocusStation: () => void;
  showToast: (text: string) => void;
}

export const useUi = create<UiState>((set) => ({
  tab: 'home',
  navigating: false,
  go: (tab) => set({ tab }),
  setNavigating: (navigating) => set({ navigating }),
  openTimer: (p) => set({ timerPrefill: p, tab: 'timer', navigating: false }),
  clearTimerPrefill: () => set({ timerPrefill: undefined }),
  showStation: (s) => set({ focusStation: s, tab: 'chargers' }),
  clearFocusStation: () => set({ focusStation: undefined }),
  showToast: (text) => {
    const id = Date.now();
    set({ toast: { text, id } });
    setTimeout(() => set((s) => (s.toast?.id === id ? { toast: undefined } : {})), 3200);
  },
}));
