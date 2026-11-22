import { useEffect, useRef, useState } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import { ArrowLeft, Check, Crosshair, Loader2, MapPin } from 'lucide-react';
import MapView from './MapView';
import { Overlay } from './ui';
import { getCurrentPosition, placeAt, type Place } from '../lib/places';
import type { LngLat } from '../lib/geo';
import { useUi } from '../store/ui';

/** Pantalla completa para elegir un punto moviendo el mapa (el pin queda fijo al centro). */
export default function MapPicker({
  title,
  initial,
  onPick,
  onClose,
}: {
  title: string;
  initial?: LngLat;
  onPick: (p: Place) => void;
  onClose: () => void;
}) {
  const [place, setPlace] = useState<Place | null>(null);
  const [moving, setMoving] = useState(true);
  const mapRef = useRef<MlMap | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const reqId = useRef(0);
  const showToast = useUi((u) => u.showToast);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const lookup = (map: MlMap) => {
    window.clearTimeout(timer.current);
    const c = map.getCenter();
    const id = ++reqId.current;
    timer.current = window.setTimeout(async () => {
      const p = await placeAt([c.lng, c.lat]);
      if (id === reqId.current) {
        setPlace(p);
        setMoving(false);
      }
    }, 300);
  };

  const onReady = (map: MlMap) => {
    mapRef.current = map;
    map.on('movestart', () => setMoving(true));
    map.on('moveend', () => lookup(map));
    map.on('click', (e) => map.easeTo({ center: e.lngLat, duration: 400 }));
    lookup(map);
  };

  async function goToMe() {
    try {
      const p = await getCurrentPosition();
      mapRef.current?.easeTo({ center: p, zoom: 15 });
    } catch (e) {
      showToast((e as Error).message);
    }
  }

  return (
    <Overlay>
    <div style={{ position: 'absolute', inset: 0, zIndex: 95, background: '#eef2f8' }}>
      <MapView center={initial ?? [-70.65, -33.44]} zoom={initial ? 14 : 11} onReady={onReady} />

      {/* pin fijo al centro */}
      <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -100%)', pointerEvents: 'none', zIndex: 3, textAlign: 'center' }}>
        <div
          style={{
            transform: moving ? 'translateY(-10px)' : 'none',
            transition: 'transform .2s',
            filter: 'drop-shadow(0 6px 10px rgba(11,27,58,.35))',
          }}
        >
          <svg width="44" height="56" viewBox="0 0 44 56">
            <path d="M22 2C11 2 3 10.5 3 21c0 14 19 32 19 32s19-18 19-32C41 10.5 33 2 22 2z" fill="#1463FF" stroke="#fff" strokeWidth="3" />
            <circle cx="22" cy="21" r="7" fill="#fff" />
          </svg>
        </div>
      </div>
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: 10, height: 5, marginLeft: -5, marginTop: -3, borderRadius: '50%', background: 'rgba(11,27,58,.35)', zIndex: 2 }} />

      {/* barra superior */}
      <div style={{ position: 'absolute', top: 'calc(var(--safe-top) + 12px)', left: 12, right: 12, zIndex: 4 }}>
        <div className="card row" style={{ padding: '10px 12px', borderRadius: 20 }}>
          <button className="icon-btn" style={{ width: 40, height: 40, boxShadow: 'none' }} onClick={onClose} aria-label="Volver">
            <ArrowLeft size={20} />
          </button>
          <div className="grow">
            <div className="bold">{title}</div>
            <div className="tiny muted">Mueve el mapa o toca un punto</div>
          </div>
        </div>
      </div>

      <button className="icon-btn" style={{ position: 'absolute', right: 14, bottom: 200, zIndex: 4 }} onClick={goToMe} aria-label="Mi ubicación">
        <Crosshair size={20} />
      </button>

      {/* tarjeta inferior */}
      <div style={{ position: 'absolute', left: 10, right: 10, bottom: 'calc(var(--safe-bottom) + 10px)', zIndex: 4 }}>
        <div className="card" style={{ borderRadius: 26, boxShadow: 'var(--shadow-lg)' }}>
          <div className="row">
            <span className="ic-bubble">{moving ? <Loader2 size={18} className="spin" /> : <MapPin size={18} />}</span>
            <div className="grow">
              <div className="bold ellipsis" style={{ fontSize: 15.5 }}>
                {moving || !place ? 'Buscando dirección…' : place.name}
              </div>
              <div className="small muted ellipsis">{!moving && place ? place.detail : ' '}</div>
            </div>
          </div>
          <button className="btn primary block mt12" disabled={moving || !place} onClick={() => place && onPick(place)}>
            <Check size={18} /> Usar este punto
          </button>
        </div>
      </div>
    </div>
    </Overlay>
  );
}
