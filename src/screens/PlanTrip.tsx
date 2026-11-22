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
  Ticket,
  Radio,
} from 'lucide-react';
import PlaceInput from '../components/PlaceInput';
import MapPicker from '../components/MapPicker';
import TripMap from '../components/TripMap';
import SocChart from '../components/SocChart';
import { RangeField, Segmented, Stepper, Toggle, socColor } from '../components/ui';
import { CARGO_KG, CARGO_LABEL, MODE_INFO, useSettings, type Cargo, type TripMode } from '../store/settings';
import { useTrip } from '../store/trip';
import { useUi } from '../store/ui';
import { useChargers, summarize, shortName, expectedWaitMin, priceStats, type Station } from '../lib/chargers';
import { billedKwh } from '../lib/car';
import { planTrip, googleMapsUrl, type TripPlan } from '../lib/planner';
import { getCurrentPosition, reverseGeocode, type Place } from '../lib/places';
import { loadTolls, groupHits } from '../lib/tolls';
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
  /** hora de salida: undefined = ahora */
  const [departAt, setDepartAt] = useState<number | undefined>(undefined);
  const [temps, setTemps] = useState<{ o?: number; d?: number }>({});
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string>();
  const [picker, setPicker] = useState<'origin' | 'dest' | null>(null);

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
      const tollData = await loadTolls();
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
          priceDc: priceStats(list).dc ?? s.priceDc,
          gasPrice: s.gasPrice,
          gasKmPerL: s.gasKmPerL,
          departAt: departAt ?? Date.now(),
        },
        list,
        undefined,
        tollData?.tolls ?? [],
        tollData?.od ?? [],
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
            onPickMap={() => setPicker('origin')}
            near={origin?.lngLat}
          />
          <PlaceInput value={dest} onChange={setDest} placeholder="¿Hacia dónde?" icon={<Flag size={18} />} near={origin?.lngLat} onPickMap={() => setPicker('dest')} />
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
        <div className="label mt12">
          <Clock size={13} /> ¿Cuándo sales? (cambia las tarifas punta y del TAG)
        </div>
        <Segmented
          value={departAt === undefined ? 'now' : 'later'}
          onChange={(v) => setDepartAt(v === 'now' ? undefined : nextHalfHour())}
          options={[
            { value: 'now', label: 'Ahora' },
            { value: 'later', label: 'Elegir hora' },
          ]}
        />
        {departAt !== undefined && (
          <div className="field mt8">
            <Clock size={18} color="var(--primary)" />
            <input
              type="datetime-local"
              value={toLocalInput(departAt)}
              onChange={(e) => e.target.value && setDepartAt(new Date(e.target.value).getTime())}
            />
          </div>
        )}
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

      {picker && (
        <MapPicker
          title={picker === 'origin' ? '¿Desde dónde sales?' : '¿A dónde vas?'}
          initial={(picker === 'origin' ? origin : dest)?.lngLat ?? origin?.lngLat ?? dest?.lngLat}
          onClose={() => setPicker(null)}
          onPick={(p) => {
            if (picker === 'origin') setOrigin(p);
            else setDest(p);
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function TripResult({ plan, onEdit, onStart }: { plan: TripPlan; onEdit: () => void; onStart: () => void }) {
  const { showStation, showToast } = useUi();
  const stations = useChargers((c) => c.stations);
  const t = plan.totals;
  const departAt = plan.input.departAt && plan.input.departAt > Date.now() + 5 * 60000 ? plan.input.departAt : undefined;
  const arriveAt = (departAt ?? Date.now()) + t.totalMin * 60000;
  const tollClp = t.tollClp ?? 0;
  const tollGroups = groupHits(plan.tolls ?? []);
  // estado y precio en vivo de cada parada
  const live = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);
  const fallbackPrice = useMemo(() => priceStats(stations).dc ?? plan.input.priceDc, [stations, plan]);
  const liveCost = plan.stops.reduce((a, s) => a + stopCost(s, live.get(s.station.id) ?? s.station, fallbackPrice, plan.input.usableKwh).cost, 0);
  const saved = t.gasCostClp - liveCost;

  const share = async () => {
    const lines = [
      `🚗⚡ ${plan.input.origin.name} → ${plan.input.destination.name}`,
      `${fmtKm(t.distanceM)} · ${fmtDuration(t.totalMin)} · llegada aprox. ${fmtTime(arriveAt)}`,
      ...plan.stops.map((s, i) => `${i + 1}. ${s.station.name}: ${Math.round(s.arriveSoc)}% → ${s.departSoc}% (${fmtDuration(s.chargeMin)})`),
      `Llegada con ${Math.round(t.arriveSoc)}% de batería`,
      plan.tolls ? `Carga ≈ ${fmtCLP(liveCost)} · Peajes y TAG ≈ ${fmtCLP(tollClp)}` : '',
      googleMapsUrl(plan),
    ];
    const text = lines.filter(Boolean).join('\n');
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
              {departAt ? `Sales ${fmtDay(departAt)} ${fmtTime(departAt)} · llegas ≈ ${fmtTime(arriveAt)}` : `Si sales ahora, llegas ≈ ${fmtTime(arriveAt)}`}
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
        <Stat icon={<Ticket size={13} />} k="Peajes y TAG" v={plan.tolls ? fmtCLP(tollClp) : '—'} />
        <Stat icon={<PiggyBank size={13} />} k="Costo carga" v={fmtCLP(liveCost)} />
      </div>

      {plan.tolls && (
        <div className="card mt12">
          <div className="row between">
            <div>
              <div className="small muted bold">Costo total del viaje</div>
              <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em' }}>{fmtCLP(liveCost + tollClp)}</div>
            </div>
            <div className="small ink2" style={{ textAlign: 'right' }}>
              <div>
                Carga <b>{fmtCLP(liveCost)}</b>
              </div>
              <div>
                Peajes y TAG <b>{fmtCLP(tollClp)}</b>
              </div>
            </div>
          </div>
          <div className="tiny muted mt8">En auto a bencina serían ≈ {fmtCLP(t.gasCostClp + tollClp)} (mismos peajes).</div>
        </div>
      )}

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
        <Timeline plan={plan} live={live} fallbackPrice={fallbackPrice} onStation={(st) => showStation(st)} />
        <div className="tiny muted mt12">
          Disponibilidad y precios en vivo desde la SEC (se actualizan cada pocos minutos). Para paradas lejanas, el estado de ahora cambia antes de que llegues: por eso se muestra la espera estimada a tu hora de llegada y un plan B. * Precio no informado por el operador: uso el precio promedio en vivo.
        </div>
      </div>

      {plan.tolls && (
        <div className="card">
          <div className="card-title">
            <Ticket size={16} /> Peajes y TAG
          </div>
          {tollGroups.length === 0 && <div className="small muted">Esta ruta no pasa por peajes ni pórticos TAG.</div>}
          {tollGroups.map((g) => (
            <div key={g.key} className="list-item">
              <span className="ic-bubble" style={{ width: 38, height: 38, background: g.kind === 'portico' ? 'var(--primary-soft)' : 'var(--surface-2)' }}>
                {g.kind === 'portico' ? <Radio size={17} /> : <Ticket size={17} />}
              </span>
              <div className="grow">
                <div className="bold ellipsis">{g.kind === 'portico' ? `${g.title} (TAG)` : `Peaje ${g.title}`}</div>
                <div className="tiny muted">
                  {g.kind === 'portico' ? `${g.count} ${g.count === 1 ? 'pórtico' : 'pórticos'}` : g.kind === 'troncal' ? `Troncal · ${g.hits[0].toll.road ?? g.hits[0].toll.concession}` : `Lateral · ${g.hits[0].toll.road ?? g.hits[0].toll.concession}`}
                  {' · pasas ≈ '}
                  {fmtTime(g.hits[0].at)}
                </div>
              </div>
              <div style={{ textAlign: 'right', flex: 'none' }}>
                <div className="bold">{fmtCLP(g.total)}</div>
                {g.band !== 'normal' && <span className="badge warn">{g.band}</span>}
                {g.band === 'normal' && g.hits.some((h) => h.toll.seasonal && h.toll.pricePeak) && (
                  <div className="tiny muted">temporada alta: hasta {fmtCLP(g.hits.reduce((a, h) => a + (h.toll.seasonal && h.toll.pricePeak ? h.toll.pricePeak : h.price), 0))}</div>
                )}
              </div>
            </div>
          ))}
          <div className="row between mt8">
            <span className="bold">Total</span>
            <span className="bold" style={{ fontSize: 17 }}>
              {fmtCLP(tollClp)}
            </span>
          </div>
          <div className="tiny muted mt8">
            Tarifas oficiales 2026 del MOP para autos y camionetas, según la hora en que pasarías por cada punto (horario normal, punta o saturación). Sin TAG, en autopistas urbanas debes comprar el Pase Diario.
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">
          <BatteryCharging size={16} /> Batería durante el viaje
        </div>
        <SocChart plan={plan} />
        <div className="tiny muted mt8">
          Consumo promedio estimado: <b>{(100 / t.kwhPer100).toLocaleString('es-CL', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} km/kWh</b>. Toca o arrastra sobre el gráfico para ver cada kilómetro. Los números son las paradas de carga.
        </div>
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

/** Costo de una parada con el precio en vivo de ese cargador */
function stopCost(s: TripPlan['stops'][number], st: Station, fallback: number, cap: number) {
  const informed = summarize(st).priceDc;
  const price = informed ?? fallback;
  const kwh = s.kwh ?? billedKwh(Math.max(0, s.arriveSoc), s.departSoc, 'DC', cap);
  return { cost: kwh * price, price, informed: !!informed };
}

/** Qué esperar al llegar, considerando la hora de llegada (no solo el estado de ahora) */
function arrivalAdvice(st: Station, etaMin: number): { tone: 'ok' | 'warn' | 'bad' | 'off'; badge: string; text: string } {
  const sum = summarize(st);
  const wait = expectedWaitMin(st, etaMin);
  const dcTotal = sum.dcFree + sum.dcBusy + sum.dcOffline;
  const when = fmtDuration(etaMin);
  if (!isFinite(wait)) return { tone: 'bad', badge: 'Fuera de servicio', text: 'El operador lo informa fuera de servicio: usa el plan B.' };
  if (sum.dcFree > 0)
    return { tone: 'ok', badge: `${sum.dcFree}/${dcTotal} libres`, text: etaMin < 40 ? 'Hay cargadores libres ahora.' : `Libre ahora; llegas en ${when}.` };
  if (sum.dcBusy > 0) {
    const since = sum.busyLongestMin !== undefined ? ` hace ${Math.round(sum.busyLongestMin)} min` : '';
    if (etaMin < 40)
      return { tone: 'warn', badge: `Ocupado${since}`, text: `Se liberaría en ~${Math.round(sum.nextFreeMin ?? 15)} min. Espera estimada al llegar: ~${Math.max(1, Math.round(wait))} min.` };
    return {
      tone: 'warn',
      badge: `Ocupado ahora`,
      text: `Llegas en ${when}: lo más probable es que ya se haya liberado (espera estimada ~${Math.max(1, Math.round(wait))} min). Una carga rápida dura ~40 min.`,
    };
  }
  return { tone: 'off', badge: 'Sin estado en vivo', text: 'El operador no está informando su estado ahora; ten a mano el plan B.' };
}

function Timeline({
  plan,
  live,
  fallbackPrice,
  onStation,
}: {
  plan: TripPlan;
  live: Map<number, Station>;
  fallbackPrice: number;
  onStation: (s: Station) => void;
}) {
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
    const advice = arrivalAdvice(st, s.etaMin);
    const cost = stopCost(s, st, fallbackPrice, plan.input.usableKwh);
    const alts = (s.alternates ?? []).map((a) => ({ ...a, station: live.get(a.station.id) ?? a.station })).slice(0, 2);
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
            <span className={`badge ${advice.tone}`}>
              <span className="dot" />
              {advice.badge}
            </span>
            <span className="badge blue">
              <BatteryCharging size={12} /> {Math.round(s.arriveSoc)}% → {s.departSoc}%
            </span>
            <span className="badge blue">
              <Clock size={12} /> {fmtDuration(s.chargeMin)}
            </span>
            <span className="badge off">
              {fmtCLP(cost.cost)} · {fmtCLP(cost.price)}/kWh{cost.informed ? '' : '*'}
            </span>
          </div>
          <div className="tiny ink2 mt8">{advice.text}</div>
          {alts.length > 0 && (
            <div className="mt8" style={{ background: 'var(--surface-2)', borderRadius: 14, padding: '8px 10px' }}>
              <div className="tiny bold muted">PLAN B</div>
              {alts.map((a) => {
                const asum = summarize(a.station);
                const dcT = asum.dcFree + asum.dcBusy + asum.dcOffline;
                const km = Math.abs(a.alongM) / 1000;
                return (
                  <button key={a.station.id} className="row" style={{ width: '100%', textAlign: 'left', padding: '5px 0', gap: 8 }} onClick={() => onStation(a.station)}>
                    <Zap size={14} color="var(--primary)" style={{ flex: 'none' }} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="small bold ellipsis" style={{ display: 'block' }}>
                        {shortName(a.station)}
                      </span>
                      <span className="tiny muted">
                        {km < 1 ? 'al lado' : `${Math.round(km)} km ${a.alongM < 0 ? 'antes' : 'después'}`} · {Math.min(120, asum.maxDcKw)} kW · {a.station.operator}
                      </span>
                    </span>
                    <span className={`badge ${asum.dcFree > 0 ? 'ok' : asum.dcBusy > 0 ? 'warn' : 'off'}`} style={{ flex: 'none' }}>
                      {asum.dcFree > 0 ? `${asum.dcFree}/${dcT} libres` : asum.dcBusy > 0 ? 'ocupado' : 'sin dato'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
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

function nextHalfHour() {
  const d = new Date(Date.now() + 30 * 60000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d.getTime();
}

function toLocalInput(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDay(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400000);
  if (d.toDateString() === today.toDateString()) return 'hoy';
  if (d.toDateString() === tomorrow.toDateString()) return 'mañana';
  return d.toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' });
}
