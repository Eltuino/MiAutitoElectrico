# MiAutitoEléctrico ⚡🚗

App para planificar viajes y cargas de nuestro **GWM Ora 5 Deluxe** (58,3 kWh · 120 kW DC · 6,6 kW AC).
Es una app web instalable (PWA): funciona en iPhone y Android desde el navegador y se puede agregar a la pantalla de inicio.

## Qué hace

- **Inicio**: el Ora 5 en 3D (con los 6 colores oficiales), batería actual, autonomía estimada según clima y uso, consejos.
- **Planificar viaje**: origen/destino, % de batería al salir y mínimo al llegar, modo **Rápido / Equilibrado / Eco (cuida la batería, 20–80 %)**, velocidad, pasajeros, carga (liviano/normal/full), clima y peajes.
  Calcula la ruta real con pendientes y temperatura, elige las **paradas de carga óptimas** entre los cargadores públicos de Chile, y muestra tiempos de carga, costo, ahorro vs bencina, el mapa coloreado por batería y el gráfico de batería + elevación.
- **Modo viaje**: navegación con mapa 3D, indicaciones de giro por voz ("En 400 metros, gire a la derecha…"), avisos de cargadores a **5 km, 2 km y 1 km** con su disponibilidad en vivo, batería estimada en tiempo real (corregible), recálculo si te sales de la ruta, aviso de batería baja y simulador para probar sin manejar.
- **Cargadores**: mapa y lista de todos los cargadores públicos de Chile con **estado en vivo** (disponible / ocupado / no disponible), potencia, precio por kWh y horario.
- **Cronómetro de carga**: dices con cuánto partes, hasta cuánto quieres cargar y el tipo de cargador; calcula el tiempo con la curva de carga del Ora 5 y **te avisa con voz, sonido y notificación** al llegar a cada % (también puede crear un recordatorio en el calendario).
- **Ajustes**: calibrar con tu consumo real (km/kWh del computador del auto), voz, precios.

## Usarla en el computador (desarrollo)

```powershell
npm install
npm run dev
```

Abre http://localhost:5173 (en el navegador puedes activar la vista de celular).

## Ponerla en los teléfonos

Para el GPS, la voz en segundo plano y la instalación, la app necesita estar en un sitio **https**.
La forma más simple: compilar y subir la carpeta `dist` a un hosting estático gratuito (Netlify, Cloudflare Pages, Vercel o GitHub Pages).

```powershell
npm run build
```

Luego, en el teléfono: abrir el link → **iPhone**: Compartir → "Agregar a inicio" · **Android**: menú ⋮ → "Instalar app".

## Usarla junto a Google Maps

En el modo viaje, botón **Google Maps**: abre la ruta con las paradas en Google Maps. Luego **vuelve a MiAutito** y déjala en pantalla:
Google Maps te sigue guiando por voz en segundo plano y MiAutito avisa cargadores y batería (apaga sus propias indicaciones de giro para no repetir).
En Android también se puede usar pantalla dividida.

> Limitación de las apps web: el teléfono no deja que una página hable o use el GPS mientras está cerrada o con la pantalla apagada.
> Por eso MiAutito mantiene la pantalla encendida durante el viaje. Para avisos con la app cerrada habría que empaquetarla como app nativa (Capacitor).

## Datos y servicios (gratuitos, sin claves)

| Qué | Fuente |
|---|---|
| Cargadores y estado en vivo | Plataforma de interoperabilidad SEC (`cargadorespublicos.cl/api/data`) |
| Rutas e instrucciones en español | Valhalla (FOSSGIS) sobre OpenStreetMap |
| Mapa | OpenFreeMap © OpenStreetMap |
| Búsqueda de lugares | Photon (Komoot) |
| Clima y temperatura | Open-Meteo |

`npm run snapshot` actualiza la copia de respaldo de cargadores (`public/data/chargers-snapshot.json`) que se usa sin conexión.

## Notas del modelo

- Ficha técnica oficial GWM Chile (FUM 11/2026). Peso (~1.700 kg), aerodinámica y curva de carga son estimaciones calibradas con datos publicados (30→80 % ≈ 20 min; 10→80 % ≈ 30 min a 120 kW).
- Todo cálculo es referencial: siempre manda lo que muestra el auto y las señales de tránsito.
