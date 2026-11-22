import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { CarColorKey } from '../lib/car';
import type { RoutePref } from '../lib/routeChoice';

export type TripMode = 'rapido' | 'equilibrado' | 'eco';
export type Cargo = 'liviano' | 'normal' | 'full';

export const CARGO_KG: Record<Cargo, number> = { liviano: 10, normal: 50, full: 140 };
export const CARGO_LABEL: Record<Cargo, string> = { liviano: 'Liviano', normal: 'Normal', full: 'Full cargado' };

export const MODE_INFO: Record<
  TripMode,
  { label: string; sub: string; speed: number; maxCharge: number; stopReserve: number; climateFactor: number; stopPenalty: number }
> = {
  rapido: { label: 'Rápido', sub: 'Llegar antes', speed: 120, maxCharge: 90, stopReserve: 8, climateFactor: 1, stopPenalty: 4 },
  equilibrado: { label: 'Equilibrado', sub: 'Lo mejor de ambos', speed: 110, maxCharge: 85, stopReserve: 12, climateFactor: 1, stopPenalty: 9 },
  eco: { label: 'Eco', sub: 'Cuida la batería', speed: 100, maxCharge: 80, stopReserve: 20, climateFactor: 0.75, stopPenalty: 14 },
};

export interface Settings {
  nickname: string;
  color: CarColorKey;
  /** % de batería actual conocido (lo actualiza el usuario) */
  soc: number;
  socUpdatedAt: number;
  /** factor de ajuste del consumo (1 = modelo base). Se calibra con el consumo real del auto */
  calibration: number;
  usableKwh: number;
  // Preferencias de viaje por defecto
  mode: TripMode;
  passengers: number;
  cargo: Cargo;
  arrivalMin: number;
  climateOn: boolean;
  /** tipo de ruta por defecto */
  routePref: RoutePref;
  /** @deprecated reemplazado por routePref */
  avoidTolls?: boolean;
  // Voz y avisos
  voiceOn: boolean;
  voiceTurns: boolean;
  voiceChargers: boolean;
  voiceAllChargers: boolean;
  voiceRate: number;
  // Precios
  priceDc: number;
  priceAc: number;
  priceHome: number;
  gasPrice: number;
  gasKmPerL: number;
  set: (p: Partial<Settings>) => void;
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      nickname: 'Mi Autito',
      color: 'turquesa',
      soc: 80,
      socUpdatedAt: 0,
      calibration: 1,
      usableKwh: 56.5,
      mode: 'equilibrado',
      passengers: 2,
      cargo: 'normal',
      arrivalMin: 15,
      climateOn: true,
      routePref: 'economica',
      voiceOn: true,
      voiceTurns: true,
      voiceChargers: true,
      voiceAllChargers: true,
      voiceRate: 1,
      priceDc: 440,
      priceAc: 300,
      priceHome: 190,
      gasPrice: 1290,
      gasKmPerL: 13,
      set: (p) => set(p),
    }),
    {
      name: 'mae.settings.v1',
      version: 2,
      // v1 tenía "Evitar peajes" (sí/no): se convierte en el tipo de ruta
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<Settings>;
        if (version < 2) return { ...p, routePref: p.avoidTolls ? 'sinpeajes' : 'economica' } as Settings;
        return p as Settings;
      },
      storage: createJSONStorage(() => {
        try {
          localStorage.setItem('__t', '1');
          localStorage.removeItem('__t');
          return localStorage;
        } catch {
          const mem = new Map<string, string>();
          return {
            getItem: (k) => mem.get(k) ?? null,
            setItem: (k, v) => void mem.set(k, v),
            removeItem: (k) => void mem.delete(k),
          };
        }
      }),
      partialize: ({ set: _s, ...rest }) => rest,
    },
  ),
);
