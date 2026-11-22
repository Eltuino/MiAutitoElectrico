export function fmtKm(meters: number, decimals?: number): string {
  const km = meters / 1000;
  if (km < 1) return `${Math.round(meters / 10) * 10} m`;
  const d = decimals ?? (km < 10 ? 1 : 0);
  return `${km.toLocaleString('es-CL', { maximumFractionDigits: d, minimumFractionDigits: d })} km`;
}

export function fmtDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Duración en formato reloj 1:05:09 o 05:09 */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

export function fmtTime(date: Date | number): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  return d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtCLP(n: number): string {
  return '$' + Math.round(n).toLocaleString('es-CL');
}

export function fmtPct(n: number): string {
  return `${Math.round(n)}%`;
}

/** "a 5 kilómetros" / "a 800 metros" para la voz */
export function speakDistance(meters: number): string {
  if (meters >= 1000) {
    const km = meters >= 20000 ? Math.round(meters / 1000) : Math.round(meters / 100) / 10;
    const txt = Number.isInteger(km) ? String(km) : km.toLocaleString('es-CL');
    return km === 1 ? '1 kilómetro' : `${txt} kilómetros`;
  }
  const m = meters >= 200 ? Math.round(meters / 100) * 100 : Math.round(meters / 10) * 10;
  return `${m} metros`;
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
