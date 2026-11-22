import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  BatteryCharging,
  CircleDot,
  Clock,
  Flag,
  Gauge,
  Leaf,
  Loader2,
  MapPinned,
  Navigation,
  Pencil,
  PiggyBank,
  Share2,
  Snowflake,
  Sun,
  ThermometerSun,
  TriangleAlert,
  Users,
  Zap,
  Route as RouteIcon,
  Fuel,
  Wind,
} from 'lucide-react';
import PlaceInput from '../components/PlaceInput';
import TripMap from '../components/TripMap';
import SocChart from '../components/SocChart';
import { RangeField, Segmented, Stepper, Toggle, socColor } from '../components/ui';
import { CARGO_KG, CARGO_LABEL, MODE_INFO, useSettings, type Cargo, type TripMode } from '../store/settings';
import { useTrip } from '../store/trip';
import { useUi } from '../store/ui';
import { useChargers, summarize, STATE_LABEL, shortName, availabilitySpeech } from '../lib/chargers';
import { planTrip, googleMapsUrl, type TripPlan } from '../lib/planner';
import { getCurrentPosition, reverseGeocode, type Place } from '../lib/places';
import { getWeather } from '../lib/weather';
import { fmtCLP, fmtDuration, fmtKm, fmtTime } from '../lib/format';

const MODE_ICON: Record<TripMode, React.ReactNode> = {
  rapido: <Zap size={18} />,
  equilibrado: <Gauge size={18} />,
  eco: <Leaf size={18} />,
};

export default function PlanTrip() {
  const s = useSettings();
  const { plan, setPlan, addRecent } = useTrip();
  const stations = useChargers((c) => c.stations);
  const refreshChargers = useChargers((c) => c.refresh);
  const { showToast, setNavigating } = useUi();
  const [editing, setEditing] = useState(!plan);

  const [origin, setOrigin] = useState<Place | undefined>(plan?.input.origin);
  const [dest, setDest] = useState<Place | undefined>(plan?.input.destination);
  const [startSoc, setStartSoc] = useState(Math.round(s.soc));
  const [arrivalMin, setArrivalMin] = useState(s.arrivalMin);
  const [mode, setMode] = useState<TripMode>(s.mode);
  const [speed, setSpeed] = useState(MODE_INFO[s.mode].speed);
  const [passengers, setPassengers] = useState(s.passengers);
  const [cargo, setCargo] = useState<Cargo>(s.cargo);
  const [climateOn, setClimateOn] = useState(s.climateOn);
  const [avoidTolls, setAvoidTolls] = useState(s.avoidTolls);
  const [temps, setTemps] = useState<{ o?: number; d?: number }>({});
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string>();

  // Usa la ubicación si el permiso ya fue concedido antes
  useEffect(() => {
    if (origin) return;
    navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then((p) => {
        if (p.state === 'granted') pickMe();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (origin) getWeather(origin.lngLat).then((w) => w && setTemps((t) => ({ ...t, o: w.tempC })));
  }, [origin]);
  useEffect(() => {
    if (dest) getWeather(dest.lngLat).then((w) => w && setTemps((t) => ({ ...t, d: w.tempC })));
  }, [dest]);

  async function pickMe() {
    setLocating(true);
    try {
      const p = await getCurrentPosition();
      const label = await reverseGeocode(p);
      setOrigin({ name: 'Mi ubicación', detail: label ?? 'Ubicación actual', lngLat: p, isMe: true });
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setLocating(false);
    }
  }

  function changeMode(m: TripMode) {
    setMode(m);
    setSpeed(MODE_INFO[m].speed);
  }

  async function calculate() {
    if (!origin || !dest) return;
    setBusy(true);
    setError(undefined);
    try {
      let list = stations;
      if (!list.length) {
        await refreshChargers();
        list = useChargers.getState().stations;
      } else refreshChargers();
      const tO = temps.o ?? 18;
      const tD = temps.d ?? tO;
      const p = await planTrip(
        {
          origin,
          destination: dest,
          startSoc,
          arrivalMin,
          mode,
          cruiseKmh: speed,
          passengers,
          cargoKg: CARGO_KG[cargo],
          climateOn,
          avoidTolls,
          calibration: s.calibration,
          usableKwh: s.usableKwh,
          tempOrigin: tO,
          tempDest: tD,
          priceDc: s.priceDc,
          gasPrice: s.gasPrice,
          gasKmPerL: s.gasKmPerL,
        },
        list,
      );
      setPlan(p);
      addRecent(dest);
      addRecent(origin);
      s.set({ mode, passengers, cargo, arrivalMin, climateOn, avoidTolls, soc: startSoc, socUpdatedAt: Date.now() });
      setEditing(false);
      document.querySelector('.screen')?.scrollTo({ top: 0 });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (plan && !editing) return <TripResult plan={plan} onEdit={() => setEditing(true)} onStart={() => setNavigating(true)} />;

  const loadTxt = `${MODE_INFO[mode].label} · ${speed} km/h · ${passengers} ${passengers === 1 ? 'persona' : 'personas'}`;

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <div className="sub">Planificador</div>
          <h1>¿A dónde vamos?</h1>
        </div>
        {plan && (
          <button className="btn soft sm" onClick={() => setEditing(false)}>
            Ver último
          </button>
        )}
      </div>

      <div className="card" style={{ position: 'relative', zIndex: 5 }}>
        <div className="stack" style={{ paddingRight: 42 }}>
          <PlaceInput
            value={origin}
            onChange={setOrigin}
            placeholder={locating ? 'Buscando tu ubicación…' : 'Desde (o usa tu ubicación)'}
            icon={locating ? <Loader2 size={18} className="spin" /> : <CircleDot size={18} />}
            allowMe
            onPickMe={pickMe}
            near={origin?.lngLat}
          />
          <PlaceInput value={dest} onChange={setDest} placeholder="¿Hacia dónde?" icon={<Flag size={18} />} near={origin?.lngLat} />
        </div>
        <button
          className="icon-btn"
          style={{ position: 'absolute', right: 14, top: 'calc(50% - 17px)', width: 34, height: 34, borderRadius: 12, zIndex: 2 }}
          onClick={() => {
            setOrigin(dest);
            setDest(origin);
          }}
          aria-label="Intercambiar"
        >
          <ArrowDownUp size={16} />
        </button>
      </div>

      <div className="card">
        <div className="card-title">
          <BatteryCharging size={16} /> Batería
        </div>
        <RangeField label="Al salir" value={startSoc} min={5} max={100} unit="%" onChange={setStartSoc} />
        <div className="mt12" />
        <RangeField label="Quiero llegar con al menos" value={arrivalMin} min={5} max={60} unit="%" onChange={setArrivalMin} />
      </div>

      <div className="card">
        <div className="card-title">
          <Gauge size={16} /> Modo de viaje
        </div>
        <Segmented
          value={mode}
          onChange={changeMode}
          options={(Object.keys(MODE_INFO) as TripMode[]).map((m) => ({
            value: m,
            label: (
              <span className="row" style={{ gap: 5 }}>
                {MODE_ICON[m]} {MODE_INFO[m].label}
              </span>
            ),
            sub: MODE_INFO[m].sub,
          }))}
        />
        <div className="small ink2 mt12" style={{ padding: '0 4px' }}>
          {mode === 'rapido' && 'Menos tiempo total: cargas cortas en los cargadores más potentes, aunque llegues más justo.'}
          {mode === 'equilibrado' && 'Buen balance entre tiempo, comodidad y margen de batería.'}
          {mode === 'eco' && 'Protege la batería: la mantiene entre 20 % y 80 %, maneja más suave y usa el clima con moderación.'}
        </div>
        <div className="mt16" />
        <RangeField label="Velocidad máxima en carretera" value={speed} min={80} max={120} step={5} unit="km/h" onChange={setSpeed} hint="Cada 10 km/h más rápido gasta ≈ 10–12 % más batería" />
      </div>

      <div className="card">
        <div className="card-title">
          <Users size={16} /> Pasajeros y carga
        </div>
        <div className="row between">
          <div>
            <div className="bold">Personas a bordo</div>
            <div className="small muted">Incluye a quien maneja</div>
          </div>
          <Stepper value={passengers} min={1} max={5} onChange={setPassengers} />
        </div>
        <div className="mt16" />
        <Segmented
          value={cargo}
          onChange={setCargo}
          options={(Object.keys(CARGO_LABEL) as Cargo[]).map((c) => ({ value: c, label: CARGO_LABEL[c], sub: `+${CARGO_KG[c]} kg` }))}
        />
      </div>

      <div className="card">
        <div className="card-title">
          <ThermometerSun size={16} /> Clima y ruta
        </div>
        <div className="grid2">
          <div className="stat">
            <div className="k">
              <Sun size={13} /> Origen
            </div>
            <div className="v">{temps.o !== undefined ? `${Math.round(temps.o)}°` : '—'}</div>
          </div>
          <div className="stat">
            <div className="k">
              <Flag size={13} /> Destino
            </div>
            <div className="v">{temps.d !== undefined ? `${Math.round(temps.d)}°` : '—'}</div>
          </div>
        </div>
        <div className="mt8" />
        <Toggle on={climateOn} onChange={setClimateOn} label={<span className="row" style={{ gap: 6 }}><Snowflake size={16} /> Aire acondicionado / calefacción</span>} sub="Se calcula según la temperatura del camino" />
        <Toggle on={avoidTolls} onChange={setAvoidTolls} label="Evitar peajes" sub="Puede alargar el viaje" />
      </div>

      {error && (
        <div className="card" style={{ background: 'var(--bad-soft)', color: 'var(--bad)', fontWeight: 700 }}>
          {error}
        </div>
      )}

      <div className="mt16" />
      <button className="btn primary block" style={{ height: 60, fontSize: 16.5 }} disabled={!origin || !dest || busy} onClick={calculate}>
        {busy ? (
          <>
            <Loader2 className="spin" size={20} /> Calculando ruta y cargas…
          </>
        ) : (
          <>
            <RouteIcon size={20} /> Calcular viaje
          </>
        )}
      </button>
      <div className="tiny muted center mt8">{loadTxt}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TripResult({ plan, onEdit, onStart }: { plan: TripPlan; onEdit: () => void; onStart: () => void }) {
  const { showStation, showToast } = useUi();
  const stations = useChargers((c) => c.stations);
  const t = plan.totals;
  const arriveAt = Date.now() + t.totalMin * 60000;
  const saved = t.gasCostClp - t.costClp;
  // estado en vivo actualizado de cada parada
  const live = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);

  const share = async () => {
    const lines = [
      `🚗⚡ ${plan.input.origin.name} → ${plan.input.destination.name}`,
      `${fmtKm(t.distanceM)} · ${fmtDuration(t.totalMin)} · llegada aprox. ${fmtTime(arriveAt)}`,
      ...plan.stops.map((s, i) => `${i + 1}. ${s.station.name}: ${Math.round(s.arriveSoc)}% → ${s.departSoc}% (${fmtDuration(s.chargeMin)})`),
      `Llegada con ${Math.round(t.arriveSoc)}% de batería`,
      googleMapsUrl(plan),
    ];
    const text = lines.join('\n');
    try {
      if (navigator.share) await navigator.share({ title: 'Mi viaje', text });
      else {
        await navigator.clipboard.writeText(text);
        showToast('Resumen copiado');
      }
    } catch {
      /* cancelado */
    }
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <div className="grow">
          <div className="sub ellipsis">
            {plan.input.origin.name} → {plan.input.destination.name}
          </div>
          <h1>Tu viaje</h1>
        </div>
        <button className="icon-btn" onClick={share} aria-label="Compartir">
          <Share2 size={18} />
        </button>
        <button className="icon-btn" onClick={onEdit} aria-label="Editar">
          <Pencil size={18} />
        </button>
      </div>

      <TripMap plan={plan} />

      <div className="card grad mt12">
        <div className="row between">
          <div>
            <div className="small" style={{ opacity: 0.85, fontWeight: 700 }}>
              Tiempo total
            </div>
            <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.1 }}>{fmtDuration(t.totalMin)}</div>
            <div className="small" style={{ opacity: 0.9, fontWeight: 600 }}>
              Si sales ahora, llegas ≈ {fmtTime(arriveAt)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 26, fontWeight: 800 }}>{fmtKm(t.distanceM)}</div>
            <div className="small" style={{ opacity: 0.9, fontWeight: 700 }}>
              {plan.stops.length === 0 ? 'Sin paradas' : `${plan.stops.length} ${plan.stops.length === 1 ? 'parada' : 'paradas'} de carga`}
            </div>
          </div>
        </div>
      </div>

      <div className="grid3 mt12">
        <Stat icon={<Navigation size={13} />} k="Manejo" v={fmtDuration(t.driveMin)} />
        <Stat icon={<BatteryCharging size={13} />} k="Cargando" v={fmtDuration(t.chargeMin)} />
        <Stat icon={<Flag size={13} />} k="Llegas con" v={`${Math.round(t.arriveSoc)}%`} color={socColor(t.arriveSoc)} />
        <Stat icon={<Zap size={13} />} k="Energía" v={`${Math.round(t.energyKwh)}`} unit="kWh" />
        <Stat icon={<Gauge size={13} />} k="Consumo" v={(100 / t.kwhPer100).toLocaleString('es-CL', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} unit="km/kWh" />
        <Stat icon={<PiggyBank size={13} />} k="Costo carga" v={fmtCLP(t.costClp)} />
      </div>

      {saved > 0 && (
        <div className="card soft mt12 row" style={{ background: 'var(--ok-soft)' }}>
          <span className="ic-bubble" style={{ background: '#fff', color: 'var(--ok)' }}>
            <Fuel size={20} />
          </span>
          <div className="grow">
            <div className="bold" style={{ color: '#0a7a47' }}>Ahorras ≈ {fmtCLP(saved)} vs bencina</div>
            <div className="small ink2">
              y evitas {Math.round(t.co2SavedKg)} kg de CO₂ <Wind size={12} />
            </div>
          </div>
        </div>
      )}

      {plan.warnings.map((w, i) => (
        <div key={i} className="card mt12 row" style={{ background: 'var(--warn-soft)', boxShadow: 'none', border: 0, alignItems: 'flex-start' }}>
          <TriangleAlert size={18} color="#C27803" style={{ flex: 'none', marginTop: 2 }} />
          <div className="small" style={{ color: '#7a4b00', fontWeight: 600 }}>
            {w}
          </div>
        </div>
      ))}

      <div className="card mt12">
        <div className="card-title">
          <MapPinned size={16} /> Itinerario
        </div>
        <Timeline plan={plan} live={live} onStation={(st) => showStation(st)} />
      </div>

      <div className="card">
        <div className="card-title">
          <BatteryCharging size={16} /> Batería durante el viaje
        </div>
        <SocChart plan={plan} />
        <div className="tiny muted mt8">Toca o arrastra sobre el gráfico para ver cada kilómetro. Los números son las paradas de carga.</div>
      </div>

      <div className="stack mt16">
        <button className="btn primary block" style={{ height: 60, fontSize: 16.5 }} onClick={onStart} disabled={!plan.feasible && plan.stops.length === 0 && t.arriveSoc < 0}>
          <Navigation size={20} /> Iniciar viaje
        </button>
        <a className="btn ghost block" href={googleMapsUrl(plan)} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
          <MapPinned size={20} color="#12B76A" />
          Abrir en Google Maps
        </a>
      </div>
      <div className="tiny muted center mt12" style={{ padding: '0 12px' }}>
        Estimaciones basadas en la ficha del Ora 5, la ruta, las pendientes y el clima. Puedes ajustar el consumo real en Ajustes.
      </div>
    </div>
  );
}

function Stat({ icon, k, v, unit, color }: { icon: React.ReactNode; k: string; v: string; unit?: string; color?: string }) {
  return (
    <div className="stat" style={{ background: 'var(--surface)', boxShadow: 'var(--shadow)' }}>
      <div className="k">
        {icon} {k}
      </div>
      <div className="v" style={{ fontSize: 17, color }}>
        {v}
        {unit && <small>{unit}</small>}
      </div>
    </div>
  );
}

function Timeline({ plan, live, onStation }: { plan: TripPlan; live: Map<number, TripPlan['stops'][number]['station']>; onStation: (s: TripPlan['stops'][number]['station']) => void }) {
  const items: React.ReactNode[] = [];
  const dot = (bg: string, child: React.ReactNode) => (
    <div style={{ width: 34, height: 34, borderRadius: 12, background: bg, color: '#fff', display: 'grid', placeItems: 'center', flex: 'none', boxShadow: '0 4px 10px rgba(20,99,255,.2)' }}>{child}</div>
  );
  let prevAlong = 0;
  const leg = (toAlong: number, key: string) => {
    const km = (toAlong - prevAlong) / 1000;
    prevAlong = toAlong;
    return (
      <div key={key} className="row" style={{ paddingLeft: 16, minHeight: 34 }}>
        <div style={{ width: 2, alignSelf: 'stretch', background: 'repeating-linear-gradient(var(--primary-2) 0 6px, transparent 6px 11px)', marginRight: 24 }} />
        <div className="small muted bold">
          <RouteIcon size={12} /> {Math.round(km)} km
        </div>
      </div>
    );
  };

  items.push(
    <div key="o" className="row">
      {dot('var(--ink)', <CircleDot size={16} />)}
      <div className="grow">
        <div className="bold ellipsis">{plan.input.origin.name}</div>
        <div className="small muted">Sales con {plan.input.startSoc}%</div>
      </div>
    </div>,
  );

  plan.stops.forEach((s, i) => {
    items.push(leg(s.alongM, `l${i}`));
    const st = live.get(s.station.id) ?? s.station;
    const sum = summarize(st);
    items.push(
      <div key={`s${i}`} className="row" style={{ alignItems: 'flex-start' }}>
        {dot('var(--primary)', <span style={{ fontWeight: 800 }}>{i + 1}</span>)}
        <div className="grow">
          <button className="bold" style={{ textAlign: 'left', fontSize: 15 }} onClick={() => onStation(st)}>
            {shortName(st)}
          </button>
          <div className="small muted">
            {st.operator} · {st.commune} · {Math.round(s.kw)} kW
          </div>
          <div className="row mt8" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className={`badge ${sum.state === 'free' ? 'ok' : sum.state === 'busy' ? 'warn' : sum.state === 'down' ? 'bad' : 'off'}`}>
              <span className="dot" />
              {sum.state === 'free' ? `${sum.free}/${sum.total} libres` : STATE_LABEL[sum.state]}
            </span>
            <span className="badge blue">
              <BatteryCharging size={12} /> {Math.round(s.arriveSoc)}% → {s.departSoc}%
            </span>
            <span className="badge blue">
              <Clock size={12} /> {fmtDuration(s.chargeMin)}
            </span>
            <span className="badge off">{fmtCLP(s.costClp)}</span>
          </div>
          <div className="tiny muted mt8">{availabilitySpeech(st)} Llegas en ≈ {fmtDuration(s.etaMin)}.</div>
        </div>
      </div>,
    );
  });

  items.push(leg(plan.totals.distanceM, 'lend'));
  items.push(
    <div key="d" className="row">
      {dot('var(--ink)', <Flag size={16} />)}
      <div className="grow">
        <div className="bold ellipsis">{plan.input.destination.name}</div>
        <div className="small muted">
          Llegas con <b style={{ color: socColor(plan.totals.arriveSoc) }}>{Math.round(plan.totals.arriveSoc)}%</b>
        </div>
      </div>
    </div>,
  );
  return <div>{items}</div>;
}
