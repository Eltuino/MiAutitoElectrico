import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Plugin de Workbox para el mapa (se copia como texto al service worker: no puede usar variables de afuera).
 * - La llave del caché no lleva la versión semanal de OpenFreeMap.
 * - Si no está en el caché normal, se busca en los mapas descargados ("map-offline").
 */
const offlineMapPlugin = {
  cacheKeyWillBeUsed: async ({ request }: { request: Request }) => request.url.replace(/\/planet\/[^/]+\/(\d+\/\d+\/\d+\.pbf)/, '/planet/$1'),
  cachedResponseWillBeUsed: async ({ request, cachedResponse }: { request: Request; cachedResponse?: Response }) =>
    cachedResponse || (await caches.match(request.url, { cacheName: 'map-offline', ignoreVary: true })) || null,
};

// BASE_PATH permite publicar en una subcarpeta (ej. GitHub Pages: /MiAutitoElectrico/)
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'MiAutitoEléctrico',
        short_name: 'MiAutito',
        description: 'Planifica viajes, cargas y rutas para tu Ora 5 eléctrico.',
        lang: 'es-CL',
        theme_color: '#1463FF',
        background_color: '#F5F8FF',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}', 'data/*.json'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            // Tiles vectoriales: se guardan sin la versión semanal en la URL; si no están en el caché
            // de navegación se buscan en los mapas descargados (src/lib/offlineMap.ts)
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/planet\/[^/]+\/\d+\/\d+\/\d+\.pbf/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 60 },
              matchOptions: { ignoreVary: true },
              plugins: [offlineMapPlugin],
            },
          },
          {
            // Estilo, TileJSON e íconos: rápido desde el caché y se actualiza por detrás
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/(styles\/|sprites\/|planet(\?.*)?$)/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'map-style', matchOptions: { ignoreVary: true }, plugins: [offlineMapPlugin] },
          },
          {
            // Fuentes y relieve de fondo (no cambian)
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/(fonts|natural_earth)\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-static',
              expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 180 },
              matchOptions: { ignoreVary: true },
              plugins: [offlineMapPlugin],
            },
          },
        ],
      },
    }),
  ],
  server: { host: true, port: 5173 },
});
