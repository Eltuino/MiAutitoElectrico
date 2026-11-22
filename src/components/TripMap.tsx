import { useEffect, useRef } from 'react';
import type { Map as MlMap, Marker } from 'maplibre-gl';
import MapView, { drawChargerDots, drawRoute, fitTo, htmlMarker, maplibregl } from './MapView';
import type { TripPlan } from '../lib/planner';
import { summarize, STATE_COLOR } from '../lib/chargers';

const BOLT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h8l-1 8 10-12h-8z"/></svg>`;

export default function TripMap({ plan, height = 300, onStopClick }: { plan: TripPlan; height?: number; onStopClick?: (i: number) => void }) {
  const mapRef = useRef<MlMap | null>(null);
  const markers = useRef<Marker[]>([]);

  const render = (map: MlMap) => {
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    drawRoute(map, plan.route.coords, plan.soc, plan.route.cum);

    // Cargadores rápidos en el camino (capa de puntos)
    const stopIds = new Set(plan.stops.map((s) => s.station.id));
    drawChargerDots(
      map,
      plan.routeChargers
        .filter((rc) => !stopIds.has(rc.station.id) && summarize(rc.station).hasDc)
        .map((rc) => ({ lng: rc.station.lng, lat: rc.station.lat, color: STATE_COLOR[summarize(rc.station).state] })),
    );

    const o = plan.input.origin.lngLat;
    const d = plan.input.destination.lngLat;
    markers.current.push(new maplibregl.Marker({ element: htmlMarker('', 'me-dot') }).setLngLat(o).addTo(map));
    const dest = htmlMarker(
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.33 2q2 0 3.67-.8a.5.5 0 0 1 .8.4v10.6a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/></svg>`,
      'map-pin',
    );
    dest.style.background = '#0B1B3A';
    markers.current.push(new maplibregl.Marker({ element: dest, anchor: 'bottom-left', offset: [-4, 4] }).setLngLat(d).addTo(map));

    plan.stops.forEach((s, i) => {
      const el = htmlMarker(`${BOLT}<span>${i + 1}</span>`, 'stop-pin');
      el.onclick = () => onStopClick?.(i);
      markers.current.push(new maplibregl.Marker({ element: el }).setLngLat([s.station.lng, s.station.lat]).addTo(map));
    });
    fitTo(map, plan.route.coords, { top: 40, bottom: 40, left: 40, right: 40 }, false);
  };

  useEffect(() => {
    if (mapRef.current) render(mapRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  useEffect(() => () => markers.current.forEach((m) => m.remove()), []);

  return (
    <div className="map-wrap" style={{ height }}>
      <MapView
        center={plan.input.origin.lngLat}
        zoom={7}
        onReady={(m) => {
          mapRef.current = m;
          render(m);
        }}
      />
    </div>
  );
}
