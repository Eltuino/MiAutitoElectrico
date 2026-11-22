import { useEffect, useMemo, useRef, useState } from 'react';
import { BatteryCharging, Bell, CalendarPlus, Check, Home as HomeIcon, MapPin, Pencil, Plug, PlugZap, Square, Thermometer, Timer, Zap, Gauge, Settings2, Loader2 } from 'lucide-react';
import BatteryRing from '../components/BatteryRing';
import { RangeField, Segmented, Sheet } from '../components/ui';
import { chargeMinutes, chargePowerAt, billedKwh, type PowerType } from '../lib/car';
import { fmtClock, fmtCLP, fmtDuration, fmtTime } from '../lib/format';
import { useSettings } from '../store/settings';
import { useTimer, sessionState, type ChargeSession } from '../store/timer';
import { useUi } from '../store/ui';
import { ensureNotifications, unlockSpeech, speak } from '../lib/voice';
import { addCalendarReminder } from '../lib/calendar';
import { useChargers, nearby, summarize, shortName } from '../lib/chargers';
import { getCurrentPosition } from '../lib/places';
import { getWeather } from '../lib/weather';

interface Preset {
  id: string;
  label: string;
  sub: string;
  kw: number;
  type: PowerType;
  icon: React.ReactNode;
}

const PRESETS: Preset[] = [
  { id: 'ultra', label: 'Ultra rápida', sub: 'DC 120+ kW', kw: 180, type: 'DC', icon: <Zap size={20} /> },
  { id: 'rapida', label: 'Rápida', sub: 'DC 50 kW', kw: 50, type: 'DC', icon: <PlugZap size={20} /> },
  { id: 'wallbox', label: 'Wallbox casa', sub: 'AC 7 kW', kw: 7, type: 'AC', icon: <HomeIcon size={20} /> },
  { id: 'ac22', label: 'AC pública', sub: 'AC 22 kW → 6,6', kw: 22, type: 'AC', icon: <Plug size={20} /> },
  { id: 'portatil', label: 'Portátil', sub: 'Enchufe 2 kW', kw: 2, type: 'AC', icon: <Plug size={20} /> },
  { id: 'custom', label: 'Otro', sub: 'Elegir kW', kw: 30, type: 'DC', icon: <Settings2 size={20} /> },
];

export default function ChargeTimer() {
  const session = useTimer((s) => s.session);
  return session ? <ActiveCharge session={session} /> : <SetupCharge />;
}

// ---------------------------------------------------------------------------

function SetupCharge() {
  const s = useSettings();
  const start = useTimer((t) => t.start);
  const { timerPrefill, clearTimerPrefill, showToast } = useUi();
  const stations = useChargers((c) => c.stations);

  const [from, setFrom] = useState(Math.round(timerPrefill?.startSoc ?? s.soc));
  const [to, setTo] = useState(timerPrefill?.targetSoc ?? 80);
  const [presetId, setPresetId] = useState(timerPrefill?.kw ? 'custom' : 'ultra');
  const [customKw, setCustomKw] = useState(timerPrefill?.kw ?? 50);
  const [customType, setCustomType] = useState<PowerType>(timerPrefill?.type ?? 'DC');
  const [tempC, setTempC] = useState(18);
  const [price, setPrice] = useState<number | undefined>(timerPrefill?.price);
  const [stationName, setStationName] = useState(timerPrefill?.stationName);
  const [milestones, setMilestones] = useState<number[]>([50, 70]);
  const [pickOpen, setPickOpen] = useState(false);
  const [near, setNear] = useState<{ s: (typeof stations)[number]; d: number }[] | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    if (timerPrefill) clearTimerPrefill();
    // temperatura del lugar si ya hay permiso de ubicación
    navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then(async (p) => {
        if (p.state !== 'granted') return;
        const pos = await getCurrentPosition();
        const w = await getWeather(pos);
        if (w) setTempC(Math.round(w.tempC));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preset = PRESETS.find((p) => p.id === presetId)!;
  const kw = presetId === 'custom' ? customKw : preset.kw;
  const type = presetId === 'custom' ? customType : preset.type;
  const effPrice = price ?? (presetId === 'wallbox' || presetId === 'portatil' ? s.priceHome : type === 'DC' ? s.priceDc : s.priceAc);
  const minutes = chargeMinutes(from, to, kw, type, tempC, s.usableKwh);
  const kwh = billedKwh(from, to, type, s.usableKwh);
  const peak = Math.round(chargePowerAt(Math.max(from, 25), kw, type, tempC));

  async function findNearby() {
    setPickOpen(true);
    setLocating(true);
    try {
      const p = await getCurrentPosition();
      setNear(nearby(stations, p, 30000, (st) => summarize(st).total > 0).slice(0, 12));
    } catch (e) {
      showToast((e as Error).message);
      setNear([]);
    } finally {
      setLocating(false);
    }
  }

  async function begin() {
    unlockSpeech();
    await ensureNotifications();
    const sess: Omit<ChargeSession, 'startedAt' | 'notified'> = {
      startSoc: from,
      targetSoc: to,
      kw,
      type,
      tempC,
      price: effPrice,
      stationName: stationName ?? (presetId !== 'custom' ? preset.label : undefined),
      milestones: milestones.filter((m) => m > from && m < to),
      capacityKwh: s.usableKwh,
    };
    start(sess);
    speak(`Cronómetro iniciado. Llegarás a ${to} por ciento en unos ${Math.round(minutes)} minutos.`, { priority: true });
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <div className="sub">Cronómetro de carga</div>
          <h1>¿Cuánto cargo?</h1>
        </div>
        <span className="ic-bubble" style={{ background: 'var(--grad)', color: '#fff', boxShadow: 'var(--shadow-blue)' }}>
          <Timer size={20} />
        </span>
      </div>

      <div className="card">
        <div className="row" style={{ gap: 16 }}>
          <BatteryRing soc={to} size={112} stroke={12} label={`${to}%`} sub={`desde ${from}%`} target={to} />
          <div className="grow">
            <div className="small muted bold">Tiempo estimado</div>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em' }}>{fmtDuration(minutes)}</div>
            <div className="small ink2">
              Listo ≈ <b>{fmtTime(Date.now() + minutes * 60000)}</b>
            </div>
            <div className="small ink2">
              {kwh.toLocaleString('es-CL', { maximumFractionDigits: 1 })} kWh · {fmtCLP(kwh * effPrice)}
            </div>
          </div>
        </div>
        <div className="mt16" />
        <RangeField label="Batería ahora" value={from} min={0} max={99} unit="%" onChange={(v) => (setFrom(v), v >= to && setTo(Math.min(100, v + 1)))} />
        <div className="mt8" />
        <RangeField label="Cargar hasta" value={to} min={Math.min(100, from + 1)} max={100} unit="%" onChange={setTo} hint={to > 80 && type === 'DC' ? 'Sobre 80 % la carga rápida se pone mucho más lenta' : undefined} />
      </div>

      <div className="card">
        <div className="card-title">
          <PlugZap size={16} /> Tipo de cargador
        </div>
        <div className="grid3">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => (setPresetId(p.id), setStationName(undefined), setPrice(undefined))}
              className="stat"
              style={{
                textAlign: 'left',
                border: `2px solid ${presetId === p.id ? 'var(--primary)' : 'transparent'}`,
                background: presetId === p.id ? 'var(--primary-soft)' : 'var(--surface-2)',
                transition: 'all .2s',
              }}
            >
              <span style={{ color: 'var(--primary)' }}>{p.icon}</span>
              <div className="bold" style={{ fontSize: 13, marginTop: 4 }}>
                {p.label}
              </div>
              <div className="tiny muted">{p.sub}</div>
            </button>
          ))}
        </div>
        {presetId === 'custom' && (
          <div className="mt12">
            <Segmented value={customType} onChange={setCustomType} options={[{ value: 'DC', label: 'DC (rápida)' }, { value: 'AC', label: 'AC (lenta)' }]} />
            <div className="mt8" />
            <RangeField label="Potencia del cargador" value={customKw} min={customType === 'AC' ? 2 : 20} max={customType === 'AC' ? 22 : 360} step={customType === 'AC' ? 0.5 : 5} unit="kW" onChange={setCustomKw} />
          </div>
        )}
        <button className="btn soft block mt12" onClick={findNearby}>
          <MapPin size={18} /> Elegir un cargador cercano
        </button>
        {stationName && (
          <div className="small ink2 mt8 center">
            <b>{stationName}</b> · {kw} kW {type}
          </div>
        )}
        <div className="small muted mt12" style={{ padding: '0 4px' }}>
          Tu Ora 5 recibe hasta <b>120 kW</b> en DC y <b>6,6 kW</b> en AC. Potencia esperada aquí: <b>≈ {peak} kW</b>.
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Thermometer size={16} /> Detalles
        </div>
        <RangeField label="Temperatura exterior" value={tempC} min={-10} max={40} unit="°C" onChange={setTempC} hint={tempC < 10 ? 'Con frío la batería acepta menos potencia' : undefined} />
        <div className="mt12" />
        <RangeField label="Precio por kWh" value={effPrice} min={0} max={800} step={10} format={(v) => fmtCLP(v)} onChange={setPrice} />
        <div className="mt12 label">
          <Bell size={13} /> Avisarme también al llegar a
        </div>
        <div className="chips">
          {[30, 40, 50, 60, 70, 80, 90].map((m) => (
            <button key={m} className={`chip ${milestones.includes(m) ? 'on' : ''}`} disabled={m <= from || m >= to} style={{ opacity: m <= from || m >= to ? 0.4 : 1 }} onClick={() => setMilestones((ms) => (ms.includes(m) ? ms.filter((x) => x !== m) : [...ms, m]))}>
              {m}%
            </button>
          ))}
        </div>
      </div>

      <div className="mt16" />
      <ChargeCurve from={from} to={to} kw={kw} type={type} tempC={tempC} cap={s.usableKwh} />

      <div className="mt16" />
      <button className="btn primary block" style={{ height: 60, fontSize: 16.5 }} onClick={begin}>
        <BatteryCharging size={20} /> Empezar a cronometrar
      </button>
      <div className="tiny muted center mt8">Te aviso con voz, sonido y notificación. Mantén la app abierta o agrega un recordatorio al calendario.</div>

      <Sheet open={pickOpen} onClose={() => setPickOpen(false)}>
        <h3 style={{ fontSize: 19, fontWeight: 800 }}>Cargadores cerca de ti</h3>
        <div className="small muted">Estado en vivo · compatibles con tu Ora 5</div>
        <div className="mt12" />
        {locating && (
          <div className="empty">
            <Loader2 className="spin" /> Buscando tu ubicación…
          </div>
        )}
        {near && !near.length && !locating && <div className="empty">No encontré cargadores cerca (30 km).</div>}
        {near?.map(({ s: st, d }) => {
          const sum = summarize(st);
          const dc = sum.hasDc;
          return (
            <button
              key={st.id}
              className="list-item"
              style={{ width: '100%', textAlign: 'left' }}
              onClick={() => {
                setPresetId('custom');
                setCustomType(dc ? 'DC' : 'AC');
                setCustomKw(dc ? sum.maxDcKw : sum.maxAcKw || 7);
                setPrice(dc ? sum.priceDc : sum.priceAc);
                setStationName(shortName(st));
                setPickOpen(false);
              }}
            >
              <span className="ic-bubble">{dc ? <Zap size={18} /> : <Plug size={18} />}</span>
              <span className="grow">
                <span className="bold ellipsis" style={{ display: 'block' }}>
                  {shortName(st)}
                </span>
                <span className="small muted">
                  {(d / 1000).toFixed(1)} km · {dc ? `${sum.maxDcKw} kW DC` : `${sum.maxAcKw} kW AC`} {sum.priceDc || sum.priceAc ? `· ${fmtCLP((dc ? sum.priceDc : sum.priceAc) ?? 0)}/kWh` : ''}
                </span>
              </span>
              <span className={`badge ${sum.state === 'free' ? 'ok' : sum.state === 'busy' ? 'warn' : sum.state === 'down' ? 'bad' : 'off'}`}>
                <span className="dot" />
                {sum.free}/{sum.total}
              </span>
            </button>
          );
        })}
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ActiveCharge({ session }: { session: ChargeSession }) {
  const { correct, clear, finish } = useTimer();
  const [now, setNow] = useState(Date.now());
  const [fixOpen, setFixOpen] = useState(false);
  const [fixVal, setFixVal] = useState(50);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const st = sessionState(session, now);
  const done = !!session.finishedAt || st.done;
  const kwNow = done ? 0 : chargePowerAt(st.soc, session.kw, session.type, session.tempC);
  const goals = [...new Set([...session.milestones, session.targetSoc])].filter((g) => g > session.startSoc).sort((a, b) => a - b);

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <div className="sub">{session.stationName ?? 'Cargando'}</div>
          <h1>{done ? '¡Carga lista!' : 'Cargando…'}</h1>
        </div>
        <span className="badge ok" style={{ fontSize: 13, padding: '7px 12px' }}>
          <span className={`dot ${done ? '' : 'pulse'}`} />
          {session.kw} kW {session.type}
        </span>
      </div>

      <div className="card" style={{ background: 'var(--grad-soft)', textAlign: 'center', padding: '26px 18px' }}>
        <div style={{ display: 'grid', placeItems: 'center' }}>
          <BatteryRing soc={st.soc} size={220} stroke={18} charging={!done} target={session.targetSoc} label={`${st.soc.toLocaleString('es-CL', { maximumFractionDigits: st.soc < 99.95 ? 1 : 0, minimumFractionDigits: st.soc < 99.95 ? 1 : 0 })}%`} sub={`objetivo ${session.targetSoc}%`} />
        </div>
        <div className="mt16 small muted bold">{done ? 'Ya puedes desconectar' : 'Tiempo restante'}</div>
        <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>{done ? <Check size={44} color="var(--ok)" /> : fmtClock(st.remainingMin * 60)}</div>
        {!done && (
          <div className="ink2 bold">
            Listo a las {fmtTime(st.etaAt)} · ahora ≈ {Math.round(kwNow)} kW
          </div>
        )}
      </div>

      <div className="grid3 mt12">
        <div className="stat" style={{ background: '#fff', boxShadow: 'var(--shadow)' }}>
          <div className="k">
            <Timer size={13} /> Llevas
          </div>
          <div className="v" style={{ fontSize: 17 }}>
            {fmtClock(st.elapsedMin * 60)}
          </div>
        </div>
        <div className="stat" style={{ background: '#fff', boxShadow: 'var(--shadow)' }}>
          <div className="k">
            <Zap size={13} /> Energía
          </div>
          <div className="v" style={{ fontSize: 17 }}>
            {st.kwhAdded.toLocaleString('es-CL', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}
            <small>kWh</small>
          </div>
        </div>
        <div className="stat" style={{ background: '#fff', boxShadow: 'var(--shadow)' }}>
          <div className="k">
            <Gauge size={13} /> Costo
          </div>
          <div className="v" style={{ fontSize: 17 }}>
            {fmtCLP(st.cost)}
          </div>
        </div>
      </div>

      <div className="card mt12">
        <div className="card-title">
          <Bell size={16} /> Avisos
        </div>
        {goals.map((g) => {
          const reached = st.soc + 0.05 >= g;
          const at = session.startedAt + st.minuteFor(g) * 60000;
          return (
            <div key={g} className="list-item">
              <span className="ic-bubble" style={{ background: reached ? 'var(--ok-soft)' : undefined, color: reached ? 'var(--ok)' : undefined }}>
                {reached ? <Check size={18} /> : <Bell size={18} />}
              </span>
              <div className="grow">
                <div className="bold">{g}%</div>
                <div className="small muted">{reached ? 'Alcanzado' : `≈ ${fmtTime(at)} (en ${fmtDuration((at - now) / 60000)})`}</div>
              </div>
              {g === session.targetSoc && <span className="badge blue">Objetivo</span>}
            </div>
          );
        })}
      </div>

      <div className="mt12" />
      <ChargeCurve from={session.startSoc} to={session.targetSoc} kw={session.kw} type={session.type} tempC={session.tempC} cap={session.capacityKwh} progressMin={st.elapsedMin} />

      <div className="stack mt16">
        {!done && (
          <div className="grid2">
            <button className="btn ghost" onClick={() => (setFixVal(Math.round(st.soc)), setFixOpen(true))}>
              <Pencil size={17} /> Corregir %
            </button>
            <button className="btn ghost" onClick={() => addCalendarReminder(`🔋 Auto cargado al ${session.targetSoc}%`, st.etaAt, `Carga en ${session.stationName ?? 'cargador'}`)}>
              <CalendarPlus size={17} /> Recordatorio
            </button>
          </div>
        )}
        {!done ? (
          <button className="btn danger block" onClick={() => (finish(), useSettings.getState().set({ soc: Math.round(st.soc), socUpdatedAt: Date.now() }))}>
            <Square size={16} /> Terminar carga ahora
          </button>
        ) : (
          <button
            className="btn primary block"
            onClick={() => {
              useSettings.getState().set({ soc: Math.round(st.soc), socUpdatedAt: Date.now() });
              clear();
            }}
          >
            <Check size={18} /> Listo, guardar {Math.round(st.soc)}%
          </button>
        )}
      </div>

      <Sheet open={fixOpen} onClose={() => setFixOpen(false)}>
        <h3 style={{ fontSize: 19, fontWeight: 800 }}>¿Qué % muestra tu auto?</h3>
        <div className="small muted">Ajusto el cálculo desde ahora con el valor real.</div>
        <div className="mt16" />
        <RangeField label="Batería real" value={fixVal} min={0} max={session.targetSoc - 1} unit="%" onChange={setFixVal} />
        <button
          className="btn primary block mt16"
          onClick={() => {
            correct(fixVal);
            setFixOpen(false);
          }}
        >
          Corregir
        </button>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Curva % de batería vs minutos de carga (una serie) con marcador de progreso */
function ChargeCurve({ from, to, kw, type, tempC, cap, progressMin }: { from: number; to: number; kw: number; type: PowerType; tempC: number; cap: number; progressMin?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(320);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const pts = useMemo(() => {
    const out: { m: number; s: number }[] = [];
    for (let s = from; s <= to + 1e-6; s += Math.max(0.5, (to - from) / 80)) out.push({ m: chargeMinutes(from, Math.min(s, to), kw, type, tempC, cap), s: Math.min(s, to) });
    if (out[out.length - 1].s < to) out.push({ m: chargeMinutes(from, to, kw, type, tempC, cap), s: to });
    return out;
  }, [from, to, kw, type, tempC, cap]);

  const total = pts[pts.length - 1].m || 1;
  const H = 150;
  const pl = 34;
  const pr = 12;
  const iw = Math.max(100, w - pl - pr);
  const x = (m: number) => pl + (m / total) * iw;
  const y = (s: number) => 10 + (1 - s / 100) * (H - 32);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.m).toFixed(1)},${y(p.s).toFixed(1)}`).join('');
  const prog = progressMin !== undefined ? Math.min(progressMin, total) : undefined;
  let progS = from;
  if (prog !== undefined) for (const p of pts) if (p.m <= prog) progS = p.s;

  return (
    <div className="card" ref={wrap} style={{ padding: '16px 14px 10px' }}>
      <div className="card-title" style={{ marginBottom: 6 }}>
        <BatteryCharging size={16} /> Curva de carga estimada
      </div>
      <svg width={w} height={H} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="ccFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1463FF" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#12C6D6" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 50, 80, 100].map((g) => (
          <g key={g}>
            <line x1={pl} x2={pl + iw} y1={y(g)} y2={y(g)} stroke="var(--line)" strokeDasharray={g === 80 ? '4 4' : undefined} />
            <text x={pl - 6} y={y(g) + 4} fontSize="10.5" textAnchor="end" fill="var(--ink-3)" fontWeight={600}>
              {g}%
            </text>
          </g>
        ))}
        <path d={`${path}L${x(total)},${y(0)}L${x(0)},${y(0)}Z`} fill="url(#ccFill)" />
        <path d={path} fill="none" stroke="#1463FF" strokeWidth={2.5} strokeLinejoin="round" />
        {prog !== undefined && (
          <>
            <line x1={x(prog)} x2={x(prog)} y1={y(100)} y2={y(0)} stroke="var(--ink-2)" strokeDasharray="3 3" />
            <circle cx={x(prog)} cy={y(progS)} r={6} fill="#1463FF" stroke="#fff" strokeWidth={2.5} />
          </>
        )}
        {[0, 0.5, 1].map((f) => (
          <text key={f} x={x(total * f)} y={H - 4} fontSize="10.5" fill="var(--ink-3)" fontWeight={600} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>
            {Math.round(total * f)} min
          </text>
        ))}
      </svg>
      <div className="tiny muted">La carga rápida es más lenta sobre 80 % para proteger la batería.</div>
    </div>
  );
}
