import { useEffect, useMemo, useState } from 'react';
import { BatteryCharging, ChevronRight, CloudSun, Lightbulb, MapPin, Navigation, Pencil, Route, Timer, Zap, Gauge, Leaf, Building2, Mountain, Plus, BookmarkPlus } from 'lucide-react';
import { useSaved } from '../store/saved';
import { SAVED_ICON } from '../components/icons';
import { ROUTE_PREFS } from '../lib/routeChoice';
import BatteryRing from '../components/BatteryRing';
import { RangeField, Sheet } from '../components/ui';
import { ORA5 } from '../lib/car';
import { estimateRangeKm } from '../lib/energy';
import { fmtClock, fmtCLP } from '../lib/format';
import { useSettings, CARGO_KG } from '../store/settings';
import { useTrip } from '../store/trip';
import { useUi } from '../store/ui';
import { useTimer, sessionState } from '../store/timer';
import { useChargers, nearby, summarize } from '../lib/chargers';
import { getCurrentPosition } from '../lib/places';
import { getWeather, weatherLabel, type Weather } from '../lib/weather';
import type { LngLat } from '../lib/geo';


const TIPS = [
  'Para el día a día, carga hasta 80 %: la batería dura más y la carga rápida es más veloz bajo ese nivel.',
  'Bajar de 120 a 100 km/h en carretera te da cerca de 20 % más autonomía.',
  'Precalienta o enfría el auto mientras está enchufado: así no gastas batería del viaje.',
  'La regeneración en nivel "fuerte" recupera energía en bajadas: ideal para la cordillera.',
  'Con frío la carga rápida es más lenta. Si puedes, carga justo después de manejar (batería tibia).',
  'Tu Ora 5 tiene V2L: puedes usar la batería para enchufar aparatos (camping, emergencias).',
  'Revisa la presión de los neumáticos: 225/60 R18 con baja presión puede subir el consumo 3–5 %.',
  'Evita dejar el auto días al 100 % o bajo 10 %. Lo ideal para guardarlo es entre 40 % y 60 %.',
];

export default function Home() {
  const s = useSettings();
  const plan = useTrip((t) => t.plan);
  const history = useTrip((t) => t.history);
  const session = useTimer((t) => t.session);
  const { go, setNavigating, startQuick, showToast } = useUi();
  const saved = useSaved((x) => x.routes);
  const stations = useChargers((c) => c.stations);
  const [socOpen, setSocOpen] = useState(false);
  const [socVal, setSocVal] = useState(Math.round(s.soc));
  const [me, setMe] = useState<LngLat>();
  const [weather, setWeather] = useState<Weather | null>(null);
  const [now, setNow] = useState(Date.now());
  const tip = useMemo(() => TIPS[Math.floor(Date.now() / 86400000) % TIPS.length], []);

  useEffect(() => {
    navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then(async (p) => {
        if (p.state !== 'granted') return;
        const pos = await getCurrentPosition();
        setMe(pos);
        setWeather(await getWeather(pos));
      })
      .catch(() => {});
    getWeather([-70.65, -33.44]).then((w) => setWeather((cur) => cur ?? w));
  }, []);

  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [session]);

  const temp = weather?.tempC ?? 18;
  const cond = { cruiseKmh: 110, passengers: s.passengers, cargoKg: CARGO_KG[s.cargo], tempC: temp, climateOn: s.climateOn, calibration: s.calibration };
  const ranges = {
    ciudad: estimateRangeKm(s.soc, cond, s.usableKwh, 'ciudad'),
    mixto: estimateRangeKm(s.soc, cond, s.usableKwh, 'mixto'),
    carretera: estimateRangeKm(s.soc, cond, s.usableKwh, 'carretera'),
  };

  const near = useMemo(() => (me ? nearby(stations, me, 10000, (st) => summarize(st).hasDc) : []), [stations, me]);
  const nearFree = near.filter((n) => summarize(n.s).free > 0).length;
  const charge = session ? sessionState(session, now) : null;
  const totals = history.reduce((a, h) => ({ km: a.km + h.distanceKm, saved: a.saved + h.savedClp, co2: a.co2 + h.co2Kg }), { km: 0, saved: 0, co2: 0 });

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Buenos días' : hour < 20 ? 'Buenas tardes' : 'Buenas noches';

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <div className="sub">{greet} 👋</div>
          <h1>{s.nickname}</h1>
        </div>
        {weather && (
          <span className="chip" style={{ background: '#fff', boxShadow: 'var(--shadow)' }}>
            <CloudSun size={16} color="var(--primary)" /> {Math.round(weather.tempC)}° · {weatherLabel(weather.code)}
          </span>
        )}
      </div>

      {/* Batería y autonomía */}
      <button className="card" style={{ width: '100%', textAlign: 'left', background: 'linear-gradient(180deg, #ffffff 0%, #eef4ff 100%)' }} onClick={() => (setSocVal(Math.round(s.soc)), setSocOpen(true))}>
        <div className="row between">
          <div>
            <div className="tiny bold muted">GWM</div>
            <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: '-0.01em' }}>Ora 5 Deluxe</div>
          </div>
          <Pencil size={18} className="muted" />
        </div>
        <div className="row mt16" style={{ gap: 18 }}>
          <BatteryRing soc={s.soc} size={120} stroke={13} sub="batería" />
          <div className="grow">
            <div className="small muted bold">Autonomía estimada</div>
            <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
              {Math.round(ranges.mixto)} <span style={{ fontSize: 16, color: 'var(--ink-3)' }}>km</span>
            </div>
            <div className="tiny muted">con {Math.round(temp)}° y uso mixto · toca para actualizar tu %</div>
          </div>
        </div>
      </button>

      {/* Rutas frecuentes: un toque calcula desde donde estés y abre la navegación */}
      {!s.turnByTurn ? null : saved.length > 0 ? (
        <div className="mt16">
          <div className="row between" style={{ padding: '0 4px 8px' }}>
            <div className="bold">Tus rutas</div>
            <div className="tiny muted bold">Toca para salir</div>
          </div>
          <div className="saved-row">
            {saved.map((r) => (
              <button key={r.id} className="saved-btn" onClick={() => startQuick(r)}>
                <span className="ic-bubble" style={{ background: 'var(--grad)', color: '#fff' }}>
                  {SAVED_ICON[r.kind]}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="bold ellipsis" style={{ fontSize: 15.5 }}>
                    {r.name}
                  </div>
                  <div className="tiny muted ellipsis">{r.destination.name}</div>
                  <div className="tiny bold ellipsis" style={{ color: 'var(--primary)', marginTop: 2 }}>
                    {ROUTE_PREFS[r.routePref].short}
                  </div>
                </div>
              </button>
            ))}
            <button
              className="saved-btn add"
              onClick={() => {
                go('trip');
                showToast('Calcula el viaje y toca "Guardar como ruta frecuente"');
              }}
            >
              <Plus size={22} />
              <span className="small">Agregar</span>
            </button>
          </div>
        </div>
      ) : (
        <button
          className="card mt12 row"
          style={{ width: '100%', textAlign: 'left', boxShadow: 'none', border: '2px dashed var(--line)', background: 'transparent' }}
          onClick={() => {
            go('trip');
            showToast('Calcula el viaje y toca "Guardar como ruta frecuente"');
          }}
        >
          <span className="ic-bubble">
            <BookmarkPlus size={20} />
          </span>
          <div className="grow">
            <div className="bold">Guarda tus rutas de siempre</div>
            <div className="small muted">Casa, Trabajo… y sales con un toque, incluso sin internet.</div>
          </div>
          <ChevronRight className="muted" />
        </button>
      )}

      {/* Carga activa */}
      {charge && session && (
        <button className="card grad mt12 row" style={{ width: '100%', textAlign: 'left' }} onClick={() => go('timer')}>
          <BatteryCharging size={28} className={charge.done ? '' : 'pulse'} />
          <div className="grow">
            <div className="bold">{charge.done ? '¡Carga lista!' : `Cargando · ${charge.soc.toFixed(0)}%`}</div>
            <div className="small" style={{ opacity: 0.9 }}>
              {charge.done ? `Llegaste a ${session.targetSoc}%` : `Faltan ${fmtClock(charge.remainingMin * 60)} para ${session.targetSoc}%`}
            </div>
          </div>
          <ChevronRight />
        </button>
      )}

      {/* Accesos rápidos */}
      <div className="grid2 mt12">
        <Action icon={<Route size={22} />} title="Planificar viaje" sub="Ruta, paradas y tiempos" onClick={() => go('trip')} primary />
        <Action icon={<Timer size={22} />} title="Cronómetro" sub="Avisos de carga" onClick={() => go('timer')} />
        <Action icon={<MapPin size={22} />} title="Cargadores" sub={me ? `${nearFree} rápidos libres cerca` : 'Estado en vivo'} onClick={() => go('chargers')} />
        {plan ? (
          <Action icon={<Navigation size={22} />} title="Seguir viaje" sub={`→ ${plan.input.destination.name}`} onClick={() => (go('trip'), setNavigating(true))} />
        ) : (
          <Action icon={<Zap size={22} />} title="Ficha Ora 5" sub="58,3 kWh · 120 kW" onClick={() => go('settings')} />
        )}
      </div>

      {/* Autonomía por tipo de uso */}
      <div className="card mt12">
        <div className="card-title">
          <Gauge size={16} /> ¿Hasta dónde llego con {Math.round(s.soc)}%?
        </div>
        <RangeBar icon={<Building2 size={16} />} label="Ciudad" km={ranges.ciudad} max={ORA5.rangeWltpKm * 1.25} />
        <RangeBar icon={<Leaf size={16} />} label="Mixto" km={ranges.mixto} max={ORA5.rangeWltpKm * 1.25} />
        <RangeBar icon={<Mountain size={16} />} label="Carretera 110 km/h" km={ranges.carretera} max={ORA5.rangeWltpKm * 1.25} />
        <div className="tiny muted mt8">Homologado WLTP: {ORA5.rangeWltpKm} km con 100 %. Considera clima, pasajeros y carga.</div>
      </div>

      <div className="card mt12 row" style={{ alignItems: 'flex-start', background: 'var(--grad-soft)', boxShadow: 'none', border: 0 }}>
        <span className="ic-bubble" style={{ background: '#fff' }}>
          <Lightbulb size={20} />
        </span>
        <div>
          <div className="bold">Consejo del día</div>
          <div className="small ink2">{tip}</div>
        </div>
      </div>

      {history.length > 0 && (
        <div className="card mt12">
          <div className="card-title">
            <Leaf size={16} /> Tus viajes eléctricos
          </div>
          <div className="grid3">
            <div className="stat">
              <div className="k">Recorrido</div>
              <div className="v" style={{ fontSize: 17 }}>
                {Math.round(totals.km).toLocaleString('es-CL')}
                <small>km</small>
              </div>
            </div>
            <div className="stat">
              <div className="k">Ahorro</div>
              <div className="v" style={{ fontSize: 17 }}>
                {fmtCLP(totals.saved)}
              </div>
            </div>
            <div className="stat">
              <div className="k">CO₂ evitado</div>
              <div className="v" style={{ fontSize: 17 }}>
                {Math.round(totals.co2)}
                <small>kg</small>
              </div>
            </div>
          </div>
        </div>
      )}

      <Sheet open={socOpen} onClose={() => setSocOpen(false)}>
        <h3 style={{ fontSize: 19, fontWeight: 800 }}>¿Cuánta batería tienes?</h3>
        <div className="small muted">Mira el % en la pantalla de tu Ora 5.</div>
        <div style={{ display: 'grid', placeItems: 'center', margin: '18px 0 6px' }}>
          <BatteryRing soc={socVal} size={150} stroke={14} />
        </div>
        <RangeField label="Batería actual" value={socVal} min={0} max={100} unit="%" onChange={setSocVal} />
        <button
          className="btn primary block mt16"
          onClick={() => {
            s.set({ soc: socVal, socUpdatedAt: Date.now() });
            setSocOpen(false);
          }}
        >
          Guardar
        </button>
      </Sheet>
    </div>
  );
}

function Action({ icon, title, sub, onClick, primary }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void; primary?: boolean }) {
  return (
    <button className={`card ${primary ? 'grad' : ''}`} style={{ textAlign: 'left', padding: 16, margin: 0 }} onClick={onClick}>
      <span className="ic-bubble" style={primary ? { background: 'rgba(255,255,255,.2)', color: '#fff' } : undefined}>
        {icon}
      </span>
      <div className="bold mt12" style={{ fontSize: 15 }}>
        {title}
      </div>
      <div className="tiny ellipsis" style={{ opacity: primary ? 0.9 : 1, color: primary ? '#fff' : 'var(--ink-3)', fontWeight: 600 }}>
        {sub}
      </div>
    </button>
  );
}

function RangeBar({ icon, label, km, max }: { icon: React.ReactNode; label: string; km: number; max: number }) {
  return (
    <div style={{ margin: '10px 0' }}>
      <div className="row between small">
        <span className="row bold ink2" style={{ gap: 6 }}>
          {icon} {label}
        </span>
        <span className="bold">{Math.round(km)} km</span>
      </div>
      <div style={{ height: 10, borderRadius: 9, background: 'var(--surface-3)', marginTop: 6, overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, (km / max) * 100)}%`, height: '100%', borderRadius: 9, background: 'var(--grad)', transition: 'width .8s' }} />
      </div>
    </div>
  );
}
