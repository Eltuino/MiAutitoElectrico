import type { LngLat } from './geo';

export interface Place {
  name: string;
  detail: string;
  lngLat: LngLat;
  /** true = ubicación actual del GPS */
  isMe?: boolean;
}

const PHOTON = 'https://photon.komoot.io';
// Chile continental + Isla de Pascua queda fuera, suficiente para viajes en auto
const CHILE_BBOX = '-76,-56.5,-66,-17.4';

function labelFrom(p: any): { name: string; detail: string } {
  const name = p.name ?? [p.street, p.housenumber].filter(Boolean).join(' ') ?? 'Lugar';
  const streetLine = p.name && p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : '';
  const area = [p.city ?? p.locality ?? p.district, p.state].filter(Boolean);
  const detail = [streetLine, ...area].filter(Boolean).join(', ');
  return { name, detail };
}

export async function searchPlaces(q: string, near?: LngLat, signal?: AbortSignal): Promise<Place[]> {
  if (q.trim().length < 3) return [];
  const params = new URLSearchParams({ q, limit: '7', bbox: CHILE_BBOX });
  if (near) {
    params.set('lat', String(near[1]));
    params.set('lon', String(near[0]));
  }
  const res = await fetch(`${PHOTON}/api/?${params}`, { signal });
  if (!res.ok) throw new Error('search failed');
  const json = await res.json();
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const f of json.features ?? []) {
    const { name, detail } = labelFrom(f.properties);
    const key = `${name}|${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, detail, lngLat: f.geometry.coordinates as LngLat });
  }
  return out;
}

export async function reverseGeocode(p: LngLat): Promise<string | null> {
  try {
    const res = await fetch(`${PHOTON}/reverse?lon=${p[0]}&lat=${p[1]}&limit=1`);
    const json = await res.json();
    const f = json.features?.[0]?.properties;
    if (!f) return null;
    const street = [f.street, f.housenumber].filter(Boolean).join(' ');
    return [street || f.name, f.city ?? f.locality].filter(Boolean).join(', ') || null;
  } catch {
    return null;
  }
}

export function getCurrentPosition(timeoutMs = 12000): Promise<LngLat> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Este dispositivo no tiene GPS disponible'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.longitude, pos.coords.latitude]),
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? 'Necesito permiso de ubicación para usar tu posición actual'
              : 'No pude obtener tu ubicación',
          ),
        ),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });
}

/** Lugares rápidos para probar (destinos típicos desde Santiago) */
export const QUICK_PLACES: Place[] = [
  { name: 'Viña del Mar', detail: 'Región de Valparaíso', lngLat: [-71.5518, -33.0245] },
  { name: 'La Serena', detail: 'Región de Coquimbo', lngLat: [-71.2542, -29.9027] },
  { name: 'Pucón', detail: 'Región de La Araucanía', lngLat: [-71.9767, -39.2823] },
  { name: 'Concepción', detail: 'Región del Biobío', lngLat: [-73.0498, -36.8201] },
  { name: 'Pichilemu', detail: "Región de O'Higgins", lngLat: [-72.0036, -34.3870] },
  { name: 'Farellones', detail: 'Región Metropolitana', lngLat: [-70.3175, -33.3540] },
];

export const SANTIAGO: Place = { name: 'Santiago Centro', detail: 'Plaza de Armas', lngLat: [-70.6506, -33.4372] };
