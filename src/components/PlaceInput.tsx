import { useEffect, useRef, useState } from 'react';
import { Clock, Crosshair, Loader2, Map as MapIcon, MapPin, Search, Sparkles, X } from 'lucide-react';
import { haversine } from '../lib/geo';
import { QUICK_PLACES, searchPlaces, type Place } from '../lib/places';
import type { LngLat } from '../lib/geo';
import { useTrip } from '../store/trip';

export default function PlaceInput({
  value,
  onChange,
  placeholder,
  icon,
  allowMe,
  near,
  onPickMe,
  onPickMap,
}: {
  value?: Place;
  onChange: (p?: Place) => void;
  placeholder: string;
  icon: React.ReactNode;
  allowMe?: boolean;
  near?: LngLat;
  onPickMe?: () => void;
  onPickMap?: () => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const recent = useTrip((s) => s.recent);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || q.trim().length < 3) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      searchPlaces(q, near, ctrl.signal)
        .then(setResults)
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 280);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open, near]);

  const pick = (p: Place) => {
    onChange(p);
    setQ('');
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div style={{ position: 'relative' }}>
      <div className="field" style={{ background: open ? '#fff' : undefined }}>
        <span style={{ color: 'var(--primary)', display: 'grid' }}>{icon}</span>
        {value && !open ? (
          <button className="grow" style={{ textAlign: 'left', minWidth: 0 }} onClick={() => (setOpen(true), setTimeout(() => inputRef.current?.focus(), 30))}>
            <div className="bold ellipsis" style={{ fontSize: 15 }}>
              {value.name}
            </div>
            {value.detail && <div className="tiny muted ellipsis">{value.detail}</div>}
          </button>
        ) : (
          <input
            ref={inputRef}
            value={q}
            placeholder={placeholder}
            onFocus={() => setOpen(true)}
            onChange={(e) => setQ(e.target.value)}
            enterKeyHint="search"
          />
        )}
        {loading && <Loader2 size={18} className="spin muted" />}
        {(value || q) && (
          <button
            aria-label="Borrar"
            onClick={() => {
              setQ('');
              onChange(undefined);
              setOpen(true);
              setTimeout(() => inputRef.current?.focus(), 30);
            }}
            className="muted"
            style={{ display: 'grid' }}
          >
            <X size={18} />
          </button>
        )}
      </div>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={() => setOpen(false)} />
          <div
            className="card"
            style={{ position: 'absolute', left: 0, right: 0, top: 56, zIndex: 31, padding: 8, maxHeight: 340, overflowY: 'auto', boxShadow: 'var(--shadow-lg)' }}
          >
            {allowMe && (
              <Row icon={<Crosshair size={18} />} title="Mi ubicación actual" detail="Usar el GPS del teléfono" onClick={() => (onPickMe?.(), setOpen(false))} blue />
            )}
            {onPickMap && (
              <Row icon={<MapIcon size={18} />} title="Elegir en el mapa" detail="Mueve el mapa y marca el punto exacto" onClick={() => (onPickMap(), setOpen(false))} />
            )}
            {results.map((p, i) => (
              <Row
                key={i}
                icon={<MapPin size={18} />}
                title={p.name}
                detail={p.detail}
                kind={p.kind}
                distance={near ? haversine(near, p.lngLat) : undefined}
                onClick={() => pick(p)}
              />
            ))}
            {q.trim().length >= 3 && !loading && !results.length && <div className="empty small">Sin resultados para “{q}”</div>}
            {q.trim().length < 3 && (
              <>
                {recent.length > 0 && <div className="tiny bold muted" style={{ padding: '8px 10px 2px' }}>RECIENTES</div>}
                {recent.slice(0, 4).map((p, i) => (
                  <Row key={`r${i}`} icon={<Clock size={18} />} title={p.name} detail={p.detail} onClick={() => pick(p)} />
                ))}
                <div className="tiny bold muted" style={{ padding: '8px 10px 2px' }}>DESTINOS POPULARES</div>
                {QUICK_PLACES.map((p, i) => (
                  <Row key={`q${i}`} icon={<Sparkles size={18} />} title={p.name} detail={p.detail} onClick={() => pick(p)} />
                ))}
              </>
            )}
            {q.trim().length < 3 && q.length > 0 && (
              <div className="tiny muted center" style={{ padding: 8 }}>
                <Search size={12} /> Escribe al menos 3 letras
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  icon,
  title,
  detail,
  onClick,
  blue,
  kind,
  distance,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  onClick: () => void;
  blue?: boolean;
  kind?: string;
  distance?: number;
}) {
  return (
    <button className="row" style={{ width: '100%', textAlign: 'left', padding: '9px 8px', borderRadius: 14 }} onClick={onClick}>
      <span className="ic-bubble" style={{ width: 36, height: 36, borderRadius: 12, background: blue ? 'var(--primary)' : undefined, color: blue ? '#fff' : undefined }}>
        {icon}
      </span>
      <span className="grow">
        <span className="bold ellipsis" style={{ display: 'block', fontSize: 14.5 }}>
          {title}
        </span>
        <span className="row" style={{ gap: 5, minWidth: 0 }}>
          {kind && (
            <span className={`badge ${kind === 'Ciudad' || kind === 'Pueblo' ? 'blue' : 'off'}`} style={{ padding: '1px 6px', fontSize: 10, flex: 'none' }}>
              {kind}
            </span>
          )}
          {detail && <span className="tiny muted ellipsis">{detail}</span>}
        </span>
      </span>
      {distance !== undefined && distance > 1000 && (
        <span className="tiny bold muted" style={{ flex: 'none' }}>
          {distance >= 100000 ? Math.round(distance / 1000) : (distance / 1000).toFixed(1).replace('.', ',')} km
        </span>
      )}
    </button>
  );
}
