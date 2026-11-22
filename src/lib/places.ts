import type { LngLat } from './geo';

export interface Place {
  name: string;
  detail: string;
  lngLat: LngLat;
  /** tipo de lugar para mostrar: Ciudad, Calle, Dirección… */
  kind?: string;
  /** true = ubicación actual del GPS */
  isMe?: boolean;
}

const PHOTON = 'https://photon.komoot.io';
// Chile continental + Isla de Pascua queda fuera, suficiente para viajes en auto
const CHILE_BBOX = '-76,-56.5,-66,-17.4';

const TOWN_TYPES = new Set(['city', 'locality', 'district', 'county']);

function kindOf(p: any): string {
  switch (p.type) {
    case 'city':
      return p.osm_value === 'village' || p.osm_value === 'hamlet' ? 'Pueblo' : 'Ciudad';
    case 'locality':
      return 'Localidad';
    case 'district':
      return 'Sector';
    case 'county':
      return 'Provincia';
    case 'street':
      return 'Calle';
    case 'house':
      return p.name ? 'Lugar' : 'Dirección';
    default:
      return 'Lugar';
  }
}

function labelFrom(p: any): { name: string; detail: string } {
  const name = p.name ?? ([p.street, p.housenumber].filter(Boolean).join(' ') || 'Lugar');
  const streetLine = p.name && p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : '';
  const commune = p.district && p.district !== p.city ? p.district : p.city ?? p.locality ?? p.county;
  const region = (p.state ?? '').replace('Región Metropolitana de Santiago', 'Región Metropolitana');
  const area = [commune !== name ? commune : null, region].filter(Boolean);
  const detail = [streetLine, ...area].filter(Boolean).join(', ');
  return { name, detail };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

async function photon(params: URLSearchParams, signal?: AbortSignal): Promise<any[]> {
  const res = await fetch(`${PHOTON}/api/?${params}`, { signal });
  if (!res.ok) throw new Error('search failed');
  const json = await res.json();
  return (json.features ?? []).filter((f: any) => !f.properties?.countrycode || f.properties.countrycode === 'CL');
}

/**
 * Busca lugares en Chile. Hace dos búsquedas a la vez:
 *  1) ciudades/comunas (sin sesgo de ubicación, para que "Concepción" sea la ciudad)
 *  2) calles, direcciones y lugares cerca de ti
 */
export async function searchPlaces(q: string, near?: LngLat, signal?: AbortSignal): Promise<Place[]> {
  if (q.trim().length < 3) return [];
  const townParams = new URLSearchParams({ q, limit: '6', bbox: CHILE_BBOX });
  for (const l of TOWN_TYPES) townParams.append('layer', l);
  const generalParams = new URLSearchParams({ q, limit: '8', bbox: CHILE_BBOX });
  if (near) {
    generalParams.set('lat', String(near[1]));
    generalParams.set('lon', String(near[0]));
  }
  const [towns, general] = await Promise.all([photon(townParams, signal).catch(() => []), photon(generalParams, signal)]);

  const nq = norm(q);
  const seen = new Set<string>();
  const out: (Place & { score: number })[] = [];
  for (const f of [...towns, ...general]) {
    const p = f.properties;
    const { name, detail } = labelFrom(p);
    const key = `${norm(name)}|${norm(detail)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isTown = TOWN_TYPES.has(p.type);
    const nn = norm(name);
    const match = nn === nq ? 0 : nn.startsWith(nq) ? 3 : 6;
    const typeRank = p.type === 'city' ? 0 : p.type === 'locality' ? 1 : 2;
    // ciudades que coinciden primero; luego lo demás en el orden de la búsqueda
    const score = (isTown ? 0 : 10) + match + typeRank + out.length * 0.01;
    out.push({ name, detail, kind: kindOf(p), lngLat: f.geometry.coordinates as LngLat, score });
  }
  return out
    .sort((a, b) => a.score - b.score)
    .slice(0, 9)
    .map(({ score: _s, ...pl }) => pl);
}

/** Dirección legible de un punto (para "elegir en el mapa") */
export async function placeAt(p: LngLat): Promise<Place> {
  try {
    const res = await fetch(`${PHOTON}/reverse?lon=${p[0]}&lat=${p[1]}&limit=1`);
    const json = await res.json();
    const f = json.features?.[0]?.properties;
    if (f) {
      const street = [f.street, f.housenumber].filter(Boolean).join(' ');
      const name = f.name && f.type !== 'street' ? f.name : street || f.name || 'Punto en el mapa';
      const { detail } = labelFrom({ ...f, name });
      return { name, detail: detail || 'Punto elegido en el mapa', lngLat: p, kind: 'Mapa' };
    }
  } catch {
    /* sin conexión */
  }
  return { name: 'Punto en el mapa', detail: `${p[1].toFixed(4)}, ${p[0].toFixed(4)}`, lngLat: p, kind: 'Mapa' };
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
