import type { LngLat } from './geo';

/**
 * Mapa sin conexión: descarga los tiles de OpenFreeMap a lo largo de una ruta (o de una zona)
 * a un caché propio. El service worker los usa cuando no hay señal (ver vite.config.ts).
 * OpenFreeMap publica una versión nueva del planeta cada semana: guardamos los tiles sin la
 * versión en la URL para que sigan sirviendo aunque la versión cambie.
 */
export const OFFLINE_CACHE = 'map-offline';
const HOST = 'https://tiles.openfreemap.org';
const TILEJSON = `${HOST}/planet`;
const STYLES = [`${HOST}/styles/positron`, `${HOST}/styles/dark`];
const GLYPH_RANGES = ['0-255', '256-511', '8192-8447'];
const DONE_KEY = 'mae.offline.v1';

/** Misma normalización que el service worker */
export const tileKey = (url: string) => url.replace(/\/planet\/[^/]+\/(\d+\/\d+\/\d+\.pbf)/, '/planet/$1');

const lon2x = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/** Zoom → cuántos tiles a cada lado de la ruta (z14 es el máximo de OpenFreeMap) */
const CORRIDOR: [number, number][] = [
  [5, 0],
  [7, 0],
  [9, 0],
  [10, 1],
  [11, 1],
  [12, 1],
  [13, 1],
  [14, 1],
];

/** Tiles "z/x/y" a lo largo de una ruta */
export function tilesAlong(coords: LngLat[]): string[] {
  const out = new Set<string>();
  for (const [z, buf] of CORRIDOR) {
    const n = 2 ** z;
    let lastKey = '';
    for (const [lng, lat] of coords) {
      const x = lon2x(lng, z);
      const y = lat2y(lat, z);
      const k = `${x}/${y}`;
      if (k === lastKey) continue;
      lastKey = k;
      for (let dx = -buf; dx <= buf; dx++)
        for (let dy = -buf; dy <= buf; dy++) {
          const tx = (x + dx + n) % n;
          const ty = y + dy;
          if (ty >= 0 && ty < n) out.add(`${z}/${tx}/${ty}`);
        }
    }
  }
  return [...out];
}

/** Tiles "z/x/y" de una zona */
export function tilesInBox(minLng: number, minLat: number, maxLng: number, maxLat: number, zmin = 5, zmax = 14): string[] {
  const out: string[] = [];
  for (let z = zmin; z <= zmax; z++) {
    const x0 = lon2x(minLng, z);
    const x1 = lon2x(maxLng, z);
    const y0 = lat2y(maxLat, z);
    const y1 = lat2y(minLat, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${z}/${x}/${y}`);
  }
  return out;
}

/** Estilos, fuentes e íconos que necesita el mapa además de los tiles */
async function staticAssets(): Promise<string[]> {
  const urls = new Set<string>([TILEJSON, ...STYLES]);
  for (const s of STYLES) {
    try {
      const style = await (await fetch(s)).json();
      if (typeof style.sprite === 'string') for (const suf of ['.json', '.png', '@2x.json', '@2x.png']) urls.add(style.sprite + suf);
      const fonts = new Set<string>();
      for (const l of style.layers ?? []) {
        const f = l.layout?.['text-font'];
        if (Array.isArray(f) && f.every((x: unknown) => typeof x === 'string')) fonts.add(f.join(','));
      }
      if (typeof style.glyphs === 'string')
        for (const f of fonts) for (const r of GLYPH_RANGES) urls.add(style.glyphs.replace('{fontstack}', encodeURIComponent(f)).replace('{range}', r));
    } catch {
      /* sin red: se reintenta en la próxima descarga */
    }
  }
  return [...urls];
}

export interface DownloadProgress {
  done: number;
  total: number;
  bytes: number;
}

/**
 * Descarga y guarda tiles (z/x/y). Lo ya guardado no se vuelve a bajar.
 * Devuelve los bytes nuevos guardados.
 */
export async function downloadTiles(keys: string[], onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal) {
  if (!('caches' in window)) throw new Error('Este navegador no permite guardar mapas.');
  // pedir que el sistema no borre lo descargado cuando falte espacio
  navigator.storage?.persist?.().catch(() => {});
  const tj = await (await fetch(TILEJSON, { signal })).json();
  const template: string = tj.tiles?.[0];
  if (!template) throw new Error('No pude leer el mapa base.');
  const urls = [...(await staticAssets()), ...keys.map((k) => template.replace('{z}/{x}/{y}', k))];
  const cache = await caches.open(OFFLINE_CACHE);
  const p: DownloadProgress = { done: 0, total: urls.length, bytes: 0 };
  let failed = 0;
  let i = 0;
  const worker = async () => {
    while (i < urls.length) {
      if (signal?.aborted) throw new DOMException('cancelado', 'AbortError');
      const url = urls[i++];
      const key = tileKey(url);
      try {
        if (!(await cache.match(key, { ignoreVary: true }))) {
          const res = await fetch(url, { signal });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            const headers = new Headers();
            for (const h of ['content-type', 'date', 'cache-control', 'access-control-allow-origin']) {
              const v = res.headers.get(h);
              if (v) headers.set(h, v);
            }
            await cache.put(key, new Response(buf, { status: 200, headers }));
            p.bytes += buf.byteLength;
          } else failed++;
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        failed++;
      }
      p.done++;
      onProgress?.({ ...p });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { ...p, failed };
}

/** Descarga el corredor de una ruta y la marca como guardada */
export async function downloadRoute(id: string, coords: LngLat[], onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal) {
  const res = await downloadTiles(tilesAlong(coords), onProgress, signal);
  if (res.failed < res.total * 0.05) markDone(id);
  return res;
}

function doneList(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function markDone(id: string) {
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([id, ...doneList().filter((x) => x !== id)].slice(0, 60)));
  } catch {
    /* sin espacio */
  }
}
export const isDownloaded = (id: string) => doneList().includes(id);

/** Cuántos archivos de mapa hay guardados y cuánto ocupa la app en total */
export async function offlineUsage(): Promise<{ files: number; usageMb?: number }> {
  let files = 0;
  try {
    if ('caches' in window && (await caches.has(OFFLINE_CACHE))) files = (await (await caches.open(OFFLINE_CACHE)).keys()).length;
  } catch {
    /* nada */
  }
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  return { files, usageMb: est?.usage !== undefined ? est.usage / 1e6 : undefined };
}

export async function clearOffline() {
  try {
    await caches.delete(OFFLINE_CACHE);
    localStorage.removeItem(DONE_KEY);
  } catch {
    /* nada */
  }
}

/** Gran Santiago (para descargar la ciudad completa) */
export const SANTIAGO_BOX: [number, number, number, number] = [-70.86, -33.65, -70.47, -33.3];
