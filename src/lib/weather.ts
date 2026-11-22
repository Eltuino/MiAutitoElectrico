import type { LngLat } from './geo';

export interface Weather {
  tempC: number;
  windKmh: number;
  code: number;
  isDay: boolean;
}

const cache = new Map<string, { ts: number; w: Weather }>();

export async function getWeather(p: LngLat): Promise<Weather | null> {
  const key = `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < 15 * 60 * 1000) return hit.w;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${p[1]}&longitude=${p[0]}&current=temperature_2m,wind_speed_10m,weather_code,is_day`;
    const res = await fetch(url);
    const j = await res.json();
    const w: Weather = {
      tempC: j.current.temperature_2m,
      windKmh: j.current.wind_speed_10m,
      code: j.current.weather_code,
      isDay: !!j.current.is_day,
    };
    cache.set(key, { ts: Date.now(), w });
    return w;
  } catch {
    return null;
  }
}

export function weatherLabel(code: number): string {
  if (code === 0) return 'Despejado';
  if (code <= 2) return 'Parcial';
  if (code === 3) return 'Nublado';
  if (code <= 48) return 'Neblina';
  if (code <= 57) return 'Llovizna';
  if (code <= 67) return 'Lluvia';
  if (code <= 77) return 'Nieve';
  if (code <= 82) return 'Chubascos';
  if (code <= 86) return 'Nieve';
  return 'Tormenta';
}
