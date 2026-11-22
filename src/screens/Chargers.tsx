import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MlMap, GeoJSONSource, Marker } from 'maplibre-gl';
import type { FeatureCollection, Point } from 'geojson';
import { Crosshair, List, Map as MapIcon, RefreshCw, Zap, Plug, Search } from 'lucide-react';
import MapView, { htmlMarker, maplibregl } from '../components/MapView';
import StationSheet from '../components/StationSheet';
import { useChargers, summarize, STATE_COLOR, shortName, nearby, type Station } from '../lib/chargers';
import { getCurrentPosition } from '../lib/places';
import { haversine, type LngLat } from '../lib/geo';
import { useUi } from '../store/ui';
import { fmtCLP } from '../lib/format';

type Filter = 'todos' | 'rapidos' | 'libres' | 'copec' | 'enel' | 'ac';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'rapidos', label: '⚡ Rápidos DC' },
  { id: 'libres', label: '🟢 Disponibles' },
  { id: 'copec', label: 'Copec Voltex' },
  { id: 'enel', label: 'Enel X' },
  { id: 'ac', label: 'AC (lenta)' },
];

function applyFilter(s: Station, f: Filter) {
  const sum = summarize(s);
  if (!sum.total) return false;
  switch (f) {
    case 'rapidos':
      return sum.hasDc;
    case 'libres':
      return sum.free > 0;
    case 'copec':
      return /copec/i.test(s.operator);
    case 'enel':
      return /enel/i.test(s.operator);
    case 'ac':
      return sum.maxAcKw > 0;
    default:
      return true;
  }
}

export default function Chargers() {
  const { stations, loading, source, updatedAt, refresh, error } = useChargers();
  const { focusStation, clearFocusStation } = useUi();
  const [filter, setFilter] = useState<Filter>('rapidos');
  const [view, setView] = useState<'map' | 'list'>('map');
  const [selected, setSelected] = useState<Station | undefined>(focusStation);
  const [me, setMe] = useState<LngLat>();
  const [q, setQ] = useState('');
  const mapRef = useRef<MlMap | null>(null);
  const meMarker = useRef<Marker | null>(null);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return stations.filter((s) => applyFilter(s, filter) && (!qq || `${s.name} ${s.commune} ${s.address} ${s.operator}`.toLowerCase().includes(qq)));
  }, [stations, filter, q]);

  const counts = useMemo(() => {
    let free = 0,
      busy = 0;
    for (const s of filtered) {
      const sum = summarize(s);
      free += sum.free;
      busy += sum.busy;
    }
    return { free, busy };
  }, [filtered]);

  useEffect(() => {
    if (focusStation) {
      setSelected(focusStation);
      mapRef.current?.flyTo({ center: [focusStation.lng, focusStation.lat], zoom: 13 });
      clearFocusStation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusStation]);

  useEffect(() => {
    navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then((p) => {
        if (p.state === 'granted') locate(false);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Actualiza los puntos del mapa
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource('chargers') as GeoJSONSource | undefined;
    src?.setData(toGeoJSON(filtered));
  }, [filtered]);

  async function locate(fly = true) {
    try {
      const p = await getCurrentPosition();
      setMe(p);
      const map = mapRef.current;
      if (map) {
        meMarker.current?.remove();
        meMarker.current = new maplibregl.Marker({ element: htmlMarker('', 'me-dot') }).setLngLat(p).addTo(map);
        if (fly) map.flyTo({ center: p, zoom: 12 });
      }
    } catch (e) {
      if (fly) useUi.getState().showToast((e as Error).message);
    }
  }

  const onReady = (map: MlMap) => {
    mapRef.current = map;
    map.addSource('chargers', { type: 'geojson', data: toGeoJSON(filtered), cluster: true, clusterRadius: 42, clusterMaxZoom: 11 });
    map.addLayer({
      id: 'clusters',
      type: 'circle',
      source: 'chargers',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#1463FF',
        'circle-opacity': 0.92,
        'circle-radius': ['step', ['get', 'point_count'], 16, 10, 20, 40, 26],
        'circle-stroke-width': 4,
        'circle-stroke-color': 'rgba(20,99,255,0.22)',
      },
    });
    map.addLayer({
      id: 'cluster-count',
      type: 'symbol',
      source: 'chargers',
      filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12.5, 'text-font': ['Noto Sans Bold'] },
      paint: { 'text-color': '#fff' },
    });
    map.addLayer({
      id: 'points',
      type: 'circle',
      source: 'chargers',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': ['case', ['get', 'dc'], 9, 6.5],
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#fff',
      },
    });
    map.addLayer({
      id: 'points-kw',
      type: 'symbol',
      source: 'chargers',
      filter: ['all', ['!', ['has', 'point_count']], ['get', 'dc']],
      minzoom: 12,
      layout: { 'text-field': ['concat', ['to-string', ['get', 'kw']], ' kW'], 'text-size': 11, 'text-offset': [0, 1.6], 'text-font': ['Noto Sans Bold'] },
      paint: { 'text-color': '#0B1B3A', 'text-halo-color': '#fff', 'text-halo-width': 1.6 },
    });
    map.on('click', 'clusters', async (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const zoom = await (map.getSource('chargers') as GeoJSONSource).getClusterExpansionZoom(f.properties!.cluster_id);
      map.easeTo({ center: (f.geometry as Point).coordinates as [number, number], zoom });
    });
    map.on('click', 'points', (e) => {
      const id = e.features?.[0]?.properties?.id;
      const st = useChargers.getState().stations.find((s) => s.id === id);
      if (st) setSelected(st);
    });
    for (const l of ['clusters', 'points']) {
      map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
    }
    if (focusStation) map.jumpTo({ center: [focusStation.lng, focusStation.lat], zoom: 13 });
    if (me) {
      meMarker.current = new maplibregl.Marker({ element: htmlMarker('', 'me-dot') }).setLngLat(me).addTo(map);
      map.jumpTo({ center: me, zoom: 11 });
    }
  };

  const listItems = useMemo(() => {
    if (me) return nearby(filtered, me, 1e7).slice(0, 60);
    return filtered.slice(0, 60).map((s) => ({ s, d: NaN }));
  }, [filtered, me]);

  const ago = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt) / 60000)) : null;

  return (
    <div className="screen" style={{ paddingBottom: view === 'map' ? 0 : undefined, display: 'flex', flexDirection: 'column' }}>
      <div className="screen-head">
        <div>
          <div className="sub">
            {source === 'live' ? '🟢 En vivo' : source === 'snapshot' ? 'Copia guardada' : 'Guardado'}
            {ago !== null && ` · hace ${ago} min`}
          </div>
          <h1>Cargadores</h1>
        </div>
        <button className="icon-btn" onClick={() => refresh(true)} aria-label="Actualizar">
          <RefreshCw size={18} className={loading ? 'spin' : ''} />
        </button>
        <button className="icon-btn" onClick={() => setView(view === 'map' ? 'list' : 'map')} aria-label="Cambiar vista">
          {view === 'map' ? <List size={18} /> : <MapIcon size={18} />}
        </button>
      </div>

      <div className="field" style={{ background: '#fff', boxShadow: 'var(--shadow)' }}>
        <Search size={18} className="muted" />
        <input placeholder="Buscar por comuna, nombre u operador" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="chips mt12">
        {FILTERS.map((f) => (
          <button key={f.id} className={`chip ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="row small mt8" style={{ gap: 12, padding: '0 4px' }}>
        <span className="muted bold">{filtered.length} lugares</span>
        <Legend color={STATE_COLOR.free} label={`${counts.free} libres`} />
        <Legend color={STATE_COLOR.busy} label={`${counts.busy} ocupados`} />
        <Legend color={STATE_COLOR.offline} label="sin dato" />
      </div>
      {error && source !== 'live' && <div className="tiny" style={{ color: '#B26B00', padding: '4px' }}>{error}</div>}

      {view === 'map' ? (
        <div className="map-wrap mt12" style={{ flex: 1, minHeight: 320, marginBottom: 'calc(var(--tabbar-h) + var(--safe-bottom) + 14px)' }}>
          <MapView center={me ?? [-70.65, -33.44]} zoom={me ? 11 : 9} onReady={onReady} />
          <button className="icon-btn blue" style={{ position: 'absolute', right: 12, bottom: 30 }} onClick={() => locate(true)} aria-label="Mi ubicación">
            <Crosshair size={20} />
          </button>
        </div>
      ) : (
        <div className="card mt12" style={{ padding: '6px 14px' }}>
          {listItems.map(({ s, d }) => {
            const sum = summarize(s);
            return (
              <button key={s.id} className="list-item" style={{ width: '100%', textAlign: 'left' }} onClick={() => setSelected(s)}>
                <span className="ic-bubble" style={{ position: 'relative' }}>
                  {sum.hasDc ? <Zap size={18} /> : <Plug size={18} />}
                  <span style={{ position: 'absolute', right: -2, top: -2, width: 12, height: 12, borderRadius: 9, background: STATE_COLOR[sum.state], border: '2px solid #fff' }} />
                </span>
                <span className="grow">
                  <span className="bold ellipsis" style={{ display: 'block' }}>
                    {shortName(s)}
                  </span>
                  <span className="small muted ellipsis" style={{ display: 'block' }}>
                    {!isNaN(d) && `${(d / 1000).toFixed(1)} km · `}
                    {s.commune} · {sum.hasDc ? `${sum.maxDcKw} kW` : `${sum.maxAcKw} kW AC`}
                    {sum.priceDc ? ` · ${fmtCLP(sum.priceDc)}/kWh` : ''}
                  </span>
                </span>
                <span className="bold small" style={{ color: STATE_COLOR[sum.state] }}>
                  {sum.free}/{sum.total}
                </span>
              </button>
            );
          })}
          {!listItems.length && <div className="empty">No hay cargadores con ese filtro.</div>}
        </div>
      )}

      <StationSheet station={selected} onClose={() => setSelected(undefined)} distanceM={selected && me ? haversine(me, [selected.lng, selected.lat]) : undefined} />
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="row tiny bold ink2" style={{ gap: 4 }}>
      <span style={{ width: 9, height: 9, borderRadius: 9, background: color }} /> {label}
    </span>
  );
}

function toGeoJSON(list: Station[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: list.map((s) => {
      const sum = summarize(s);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: { id: s.id, color: STATE_COLOR[sum.state], dc: sum.hasDc, kw: sum.hasDc ? sum.maxDcKw : sum.maxAcKw },
      };
    }),
  };
}
