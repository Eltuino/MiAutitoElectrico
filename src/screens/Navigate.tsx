import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Map as MlMap, Marker } from 'maplibre-gl';
import {
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  BatteryCharging,
  CornerUpLeft,
  CornerUpRight,
  Crosshair,
  Flag,
  LocateFixed,
  Merge,
  Navigation as NavIcon,
  Pencil,
  PlayCircle,
  RotateCw,
  Timer,
  Undo2,
  Volume2,
  VolumeX,
  X,
  Zap,
  PartyPopper,
  Gauge,
  MapPinned,
} from 'lucide-react';
import MapView, { drawChargerDots, drawRoute, fitTo, htmlMarker, isNight, maplibregl } from '../components/MapView';
import BatteryRing from '../components/BatteryRing';
import { RangeField, Sheet, socColor } from '../components/ui';
import { useTrip } from '../store/trip';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { useChargers, summarize, STATE_COLOR, shortName } from '../lib/chargers';
import { bearing, pointAt, snapToRoute, haversine, type LngLat } from '../lib/geo';
import { getRoute, maneuverIcon, ARRIVE_TYPES } from '../lib/routing';
import { chargersAlong, googleMapsUrl } from '../lib/planner';
import { chargerAlertText, farText, isFastCharger, maneuverThresholds, navFromPlan, rebuildNav, spokenName, type NavRoute } from '../lib/nav';
import { chime, keepScreenOn, speak, unlockSpeech, vibrate, ensureNotifications, notify, stopSpeaking } from '../lib/voice';
import { fmtDuration, fmtKm, fmtTime, speakDistance } from '../lib/format';

const PROGRESS_KEY = 'mae.nav.v1';

type Source = 'gps' | 'sim';

interface NavState {
  started: boolean;
  source: Source;
  along: number;
  idx: number;
  pos?: LngLat;
  heading: number;
  speedKmh: number;
  offSince: number;
  rerouting: boolean;
  fired: Set<string>;
  socOffset: number;
  arrived: Set<number>;
  finished: boolean;
  following: boolean;
  simFactor: number;
  lastSave: number;
  lastRender: number;
  lastFix: number;
}

const ICONS = {
  straight: ArrowUp,
  right: CornerUpRight,
  left: CornerUpLeft,
  'slight-right': ArrowUpRight,
  'slight-left': ArrowUpLeft,
  'sharp-right': CornerUpRight,
  'sharp-left': CornerUpLeft,
  uturn: Undo2,
  roundabout: RotateCw,
  arrive: Flag,
  depart: NavIcon,
  merge: Merge,
  'exit-right': ArrowUpRight,
  'exit-left': ArrowUpLeft,
} as const;

const PUCK = `<svg width="46" height="46" viewBox="0 0 46 46"><circle cx="23" cy="23" r="21" fill="rgba(20,99,255,.18)"/><circle cx="23" cy="23" r="15" fill="#fff"/><path d="M23 11 L31 32 L23 27.5 L15 32 Z" fill="#1463FF" stroke="#1463FF" stroke-width="2" stroke-linejoin="round"/></svg>`;

export default function Navigate() {
  const plan = useTrip((t) => t.plan);
  const addHistory = useTrip((t) => t.addHistory);
  const settings = useSettings();
  const { setNavigating, openTimer, showToast } = useUi();
  const [, render] = useReducer((x: number) => x + 1, 0);
  const [arrivalStop, setArrivalStop] = useState<{ i: number; soc: number } | null>(null);
  const [fixOpen, setFixOpen] = useState(false);
  const [fixVal, setFixVal] = useState(50);
  const [gmapsOpen, setGmapsOpen] = useState(false);
  const [night] = useState(() => isNight());

  const mapRef = useRef<MlMap | null>(null);
  const puck = useRef<Marker | null>(null);
  const markers = useRef<Marker[]>([]);
  const nav = useRef<NavRoute | null>(plan ? navFromPlan(plan) : null);
  const watchId = useRef<number | null>(null);
  const simTimer = useRef<number | null>(null);
  const lastChargerSpeech = useRef(0);
  const s = useRef<NavState>({
    started: false,
    source: 'gps',
    along: 0,
    idx: 0,
    heading: 0,
    speedKmh: 0,
    offSince: 0,
    rerouting: false,
    fired: new Set(),
    socOffset: 0,
    arrived: new Set(),
    finished: false,
    following: true,
    simFactor: 12,
    lastSave: 0,
    lastRender: 0,
    lastFix: 0,
  });

  // Restaurar progreso si se cerró la app a mitad de viaje
  useEffect(() => {
    if (!plan) return;
    try {
      const saved = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? 'null');
      if (saved?.planId === plan.id && Date.now() - saved.t < 12 * 3600 * 1000) {
        s.current.socOffset = saved.socOffset ?? 0;
        s.current.fired = new Set(saved.fired ?? []);
        s.current.arrived = new Set(saved.arrived ?? []);
        s.current.along = saved.sim ? saved.along ?? 0 : 0;
        s.current.source = saved.sim ? 'sim' : 'gps';
      }
    } catch {
      /* nada */
    }
  }, [plan]);

  const saveProgress = useCallback(() => {
    if (!plan) return;
    const st = s.current;
    try {
      localStorage.setItem(
        PROGRESS_KEY,
        JSON.stringify({ planId: plan.id, along: st.along, socOffset: st.socOffset, fired: [...st.fired].filter((k) => k.startsWith('c-') || k.startsWith('arr-')), arrived: [...st.arrived], sim: st.source === 'sim', t: Date.now() }),
      );
    } catch {
      /* nada */
    }
  }, [plan]);

  // -------------------------------------------------------------------------
  // Mapa
  const drawAll = useCallback(() => {
    const map = mapRef.current;
    const n = nav.current;
    if (!map || !n) return;
    drawRoute(map, n.route.coords, n.soc, n.route.cum);
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    const stopIds = new Set(n.stops.map((x) => x.station.id));
    drawChargerDots(
      map,
      n.chargers
        .filter((rc) => !stopIds.has(rc.station.id) && isFastCharger(rc.station))
        .map((rc) => ({ lng: rc.station.lng, lat: rc.station.lat, color: STATE_COLOR[summarize(rc.station).state] })),
    );
    n.stops.forEach((st, i) => {
      const num = (plan?.stops.findIndex((p) => p.station.id === st.station.id) ?? i) + 1;
      const el = htmlMarker(`<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h8l-1 8 10-12h-8z"/></svg><span>${num}</span>`, 'stop-pin');
      markers.current.push(new maplibregl.Marker({ element: el }).setLngLat([st.station.lng, st.station.lat]).addTo(map));
    });
    const dest = htmlMarker('', 'map-pin');
    dest.style.background = '#0B1B3A';
    markers.current.push(new maplibregl.Marker({ element: dest, anchor: 'bottom-left', offset: [-4, 4] }).setLngLat(n.route.coords[n.route.coords.length - 1]).addTo(map));
  }, [plan]);

  const onMapReady = (map: MlMap) => {
    mapRef.current = map;
    drawAll();
    const n = nav.current!;
    const start = pointAt(n.route.coords, n.route.cum, s.current.along).point;
    puck.current = new maplibregl.Marker({ element: htmlMarker(PUCK), rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(start).addTo(map);
    fitTo(map, n.route.coords, { top: 200, bottom: 260, left: 40, right: 40 }, false);
    map.on('dragstart', () => {
      s.current.following = false;
      render();
    });
  };

  // -------------------------------------------------------------------------
  // Lógica principal: cada nueva posición
  const update = useCallback(
    (pos: LngLat, speedKmh: number, heading: number | null, known?: { along: number; idx: number }) => {
      const st = s.current;
      const n = nav.current;
      if (!n || !plan || st.finished) return;
      const r = n.route;
      const now = Date.now();
      const voice = useSettings.getState();

      // 1) proyectar sobre la ruta
      let along: number;
      let idx: number;
      if (known) {
        along = known.along;
        idx = known.idx;
      } else {
        // si pasó mucho rato sin GPS (app en segundo plano), buscar en toda la ruta
        const fresh = st.pos && now - st.lastFix < 30000;
        st.lastFix = now;
        const snap = snapToRoute(pos, r.coords, r.cum, fresh ? st.idx : undefined);
        along = snap.along;
        idx = snap.index;
        // fuera de ruta → recalcular
        if (snap.dist > 70) {
          if (!st.offSince) st.offSince = now;
          if (now - st.offSince > 9000 && !st.rerouting) reroute(pos);
        } else st.offSince = 0;
      }
      st.pos = pos;
      st.along = along;
      st.idx = idx;
      st.speedKmh = speedKmh;
      const hd = heading ?? bearing(pos, pointAt(r.coords, r.cum, along + 40).point);
      st.heading = hd;

      const socNow = socAt(n, idx, along) + st.socOffset;

      // 2) maniobras
      const mi = nextManeuverIndex(n, along);
      const m = mi >= 0 ? r.maneuvers[mi] : null;
      if (m && voice.voiceOn && voice.voiceTurns && !ARRIVE_TYPES.has(m.type)) {
        const dist = m.alongM - along;
        const roadKmh = Math.max(speedKmh, r.speed[idx] ?? 40);
        const th = maneuverThresholds(roadKmh);
        const key = `m-${mi}-${Math.round(m.alongM)}`;
        if (dist <= th.near && !st.fired.has(`${key}-near`)) {
          st.fired.add(`${key}-near`).add(`${key}-far`);
          speak(stopWording(m.pre ?? m.instruction, m.leg < r.legEnds.length - 1));
        } else if (dist <= th.far && dist > th.near * 1.8 && !st.fired.has(`${key}-far`)) {
          st.fired.add(`${key}-far`);
          speak(stopWording(farText(m, Math.round(dist / 50) * 50), m.leg < r.legEnds.length - 1));
        }
      }

      // 3) cargadores en el camino (5 km, 2 km, 1 km)
      if (voice.voiceOn && voice.voiceChargers) {
        const stopIds = new Map(n.stops.map((x) => [x.station.id, x]));
        let spoke = false;
        for (const rc of n.chargers) {
          const dist = rc.alongM - along;
          if (dist < 0 || dist > 5200) continue;
          const stop = stopIds.get(rc.station.id);
          if (!stop) {
            if (!voice.voiceAllChargers || !isFastCharger(rc.station) || rc.offsetM > 600) continue;
            const state = summarize(rc.station).state;
            if (state === 'offline' || state === 'down') continue;
            // en ciudad hay demasiados: solo avisamos los de carretera
            const ci = idxAt(r.cum, rc.alongM);
            if ((r.speed[ci] ?? 0) < 70 && (r.speed[idx] ?? 0) < 70) continue;
            // no encadenar avisos de cargadores muy seguidos
            if (now - lastChargerSpeech.current < 25000 && !st.fired.has(`c-${rc.station.id}-5000`)) continue;
          }
          for (const t of [5000, 2000, 1000]) {
            const key = `c-${rc.station.id}-${t}`;
            if (st.fired.has(key)) continue;
            if (dist <= t && dist > t - 700) {
              st.fired.add(key);
              if (!spoke) {
                const num = stop ? plan.stops.findIndex((p) => p.station.id === rc.station.id) + 1 : undefined;
                chime('soft');
                lastChargerSpeech.current = now;
                speak(chargerAlertText(rc.station, t, num || undefined, stop ? estimateSocAt(n, stop.navAlong) + st.socOffset : undefined));
                spoke = true;
              }
            } else if (dist <= t - 700) st.fired.add(key); // ya pasamos ese umbral
          }
        }
      }

      // 4) llegada a una parada de carga
      n.stops.forEach((stop, i) => {
        if (st.arrived.has(stop.station.id)) return;
        const d = stop.navAlong - along;
        const near = haversine(pos, [stop.station.lng, stop.station.lat]);
        if ((d < 60 && d > -400) || near < 90) {
          st.arrived.add(stop.station.id);
          setArrivalStop({ i, soc: socNow });
          if (st.source === 'sim') stopSim(); // en la vida real el auto se detiene a cargar
          vibrate([300, 120, 300]);
          chime('done');
          const min = Math.round(stop.chargeMin);
          speak(`Llegaste a tu parada de carga, ${spokenName(stop.station)}. Carga hasta ${stop.departSoc} por ciento, unos ${min} minutos.`, { priority: true });
          notify('⚡ Parada de carga', `${shortName(stop.station)}: carga hasta ${stop.departSoc}% (≈ ${min} min)`, 'stop');
        }
      });

      // 5) batería baja sin parada cerca
      if (socNow < 10 && !st.fired.has('low-10')) {
        st.fired.add('low-10');
        const next = n.chargers.find((c) => c.alongM > along && isFastCharger(c.station));
        speak(
          next
            ? `Atención, batería baja: ${Math.max(0, Math.round(socNow))} por ciento. El cargador rápido más cercano en tu ruta es ${spokenName(next.station)}, a ${speakDistance(next.alongM - along)}.`
            : `Atención, batería baja: ${Math.max(0, Math.round(socNow))} por ciento.`,
          { priority: true },
        );
      }

      // 6) destino
      if (along >= r.distanceM - 35) finish(socNow);

      // 7) cámara
      const map = mapRef.current;
      if (map) {
        puck.current?.setLngLat(pos).setRotation(hd);
        if (st.following) {
          const z = speedKmh > 85 ? 14.6 : speedKmh > 50 ? 15.6 : 16.6;
          map.easeTo({ center: pos, bearing: hd, pitch: 52, zoom: z, duration: st.source === 'sim' ? 260 : 900, easing: (t) => t, padding: { top: 250, bottom: 150, left: 0, right: 0 } });
        }
      }

      if (now - st.lastSave > 5000) {
        st.lastSave = now;
        saveProgress();
      }
      if (now - st.lastRender > 240) {
        st.lastRender = now;
        render();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan],
  );

  async function reroute(pos: LngLat) {
    const st = s.current;
    const n = nav.current;
    if (!plan || !n) return;
    st.rerouting = true;
    render();
    speak('Recalculando ruta.');
    try {
      const remaining = n.stops.filter((x) => !st.arrived.has(x.station.id) && x.navAlong > st.along);
      const pts: LngLat[] = [pos, ...remaining.map((x) => [x.station.lng, x.station.lat] as LngLat), plan.input.destination.lngLat];
      const route = await getRoute(pts, { topSpeed: plan.input.cruiseKmh, avoidTolls: plan.input.avoidTolls });
      const socNow = socAt(n, st.idx, st.along) + st.socOffset;
      nav.current = rebuildNav(plan, route, socNow, remaining, chargersAlong(route, useChargers.getState().stations));
      st.socOffset = 0;
      st.along = 0;
      st.idx = 0;
      st.offSince = 0;
      for (const k of [...st.fired]) if (k.startsWith('m-')) st.fired.delete(k);
      drawAll();
    } catch {
      showToast('No pude recalcular la ruta');
    } finally {
      st.rerouting = false;
      render();
    }
  }

  function finish(socNow: number) {
    const st = s.current;
    if (st.finished || !plan) return;
    st.finished = true;
    stopSim();
    chime('done');
    vibrate([300, 100, 300, 100, 600]);
    speak(`¡Llegaste a tu destino! Llegas con ${Math.max(0, Math.round(socNow))} por ciento de batería.`, { priority: true });
    useSettings.getState().set({ soc: Math.max(0, Math.round(socNow)), socUpdatedAt: Date.now() });
    const t = plan.totals;
    addHistory({
      id: plan.id,
      date: Date.now(),
      from: plan.input.origin.name,
      to: plan.input.destination.name,
      distanceKm: t.distanceM / 1000,
      energyKwh: t.energyKwh,
      stops: plan.stops.length,
      costClp: t.costClp,
      savedClp: Math.max(0, t.gasCostClp - t.costClp),
      co2Kg: t.co2SavedKg,
      totalMin: t.totalMin,
    });
    localStorage.removeItem(PROGRESS_KEY);
    render();
  }

  // -------------------------------------------------------------------------
  // Fuentes de posición
  function startGps() {
    stopSim();
    if (!('geolocation' in navigator)) {
      showToast('Este dispositivo no tiene GPS');
      return;
    }
    s.current.source = 'gps';
    watchId.current = navigator.geolocation.watchPosition(
      (p) => {
        if (p.coords.accuracy > 120) return; // lectura muy imprecisa
        const speed = p.coords.speed != null && p.coords.speed >= 0 ? p.coords.speed * 3.6 : s.current.speedKmh;
        const heading = p.coords.heading != null && !isNaN(p.coords.heading) && speed > 6 ? p.coords.heading : null;
        update([p.coords.longitude, p.coords.latitude], speed, heading);
      },
      (err) => {
        showToast(err.code === err.PERMISSION_DENIED ? 'Activa el permiso de ubicación para navegar' : 'Sin señal GPS…');
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
  }

  function startSim() {
    stopGps();
    stopSim();
    const st = s.current;
    st.source = 'sim';
    let last = performance.now();
    simTimer.current = window.setInterval(() => {
      const n = nav.current;
      if (!n || st.finished) return;
      const nowT = performance.now();
      const dt = Math.min(1, (nowT - last) / 1000);
      last = nowT;
      const r = n.route;
      const kmh = Math.min(r.speed[st.idx] ?? 50, plan!.input.cruiseKmh);
      const nextAlong = Math.min(r.distanceM, st.along + (kmh / 3.6) * dt * st.simFactor);
      const { point, index } = pointAt(r.coords, r.cum, nextAlong);
      const ahead = pointAt(r.coords, r.cum, nextAlong + 35).point;
      update(point, kmh, bearing(point, ahead), { along: nextAlong, idx: index });
    }, 250);
  }

  function stopSim() {
    if (simTimer.current) clearInterval(simTimer.current);
    simTimer.current = null;
  }
  function stopGps() {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
  }

  function continueAfterStop() {
    setArrivalStop(null);
    if (s.current.source === 'sim' && !s.current.finished && !simTimer.current) startSim();
  }

  async function begin(source: Source) {
    unlockSpeech();
    keepScreenOn(true);
    ensureNotifications();
    s.current.started = true;
    s.current.following = true;
    render();
    const n = nav.current!;
    const resumed = s.current.along > 200;
    const first = resumed ? null : n.route.maneuvers[0];
    const stops = n.stops.filter((x) => !s.current.arrived.has(x.station.id)).length;
    const left = speakDistance(Math.max(0, n.route.distanceM - s.current.along));
    speak(
      `${resumed ? 'Seguimos' : 'Comenzamos'}. ${left} hasta ${plan!.input.destination.name}${stops ? `, con ${stops} ${stops === 1 ? 'parada' : 'paradas'} de carga` : ''}. ${first ? first.pre ?? '' : ''}`,
      { priority: true },
    );
    if (source === 'gps') startGps();
    else startSim();
  }

  useEffect(() => {
    return () => {
      stopGps();
      stopSim();
      keepScreenOn(false);
      stopSpeaking();
      saveProgress();
      markers.current.forEach((m) => m.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!plan || !nav.current) {
    return (
      <div className="screen" style={{ zIndex: 90, background: 'var(--bg)' }}>
        <div className="empty">No hay un viaje planificado.</div>
        <button className="btn primary block" onClick={() => setNavigating(false)}>
          Volver
        </button>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Datos para la interfaz
  const st = s.current;
  const n = nav.current;
  const r = n.route;
  const remainingM = Math.max(0, r.distanceM - st.along);
  const driveLeftS = Math.max(0, r.timeS - (r.cumT[st.idx] ?? 0));
  const pendingStops = n.stops.filter((x) => !st.arrived.has(x.station.id) && x.navAlong > st.along - 50);
  const chargeLeftMin = pendingStops.reduce((a, x) => a + x.chargeMin + 5, 0);
  const etaAt = Date.now() + driveLeftS * 1000 + chargeLeftMin * 60000;
  const socNow = socAt(n, st.idx, st.along) + st.socOffset;
  const socArrive = n.soc[n.soc.length - 1] + st.socOffset;
  const nextStop = pendingStops[0];
  const socAtNext = nextStop ? estimateSocAt(n, nextStop.navAlong) + st.socOffset : null;
  const mi = nextManeuverIndex(n, st.along);
  const m = mi >= 0 ? r.maneuvers[mi] : null;
  const mDist = m ? Math.max(0, m.alongM - st.along) : 0;
  const Icon = m ? ICONS[maneuverIcon(m.type)] : ArrowUp;
  const nextCharger = n.chargers.find((c) => c.alongM > st.along && (n.stops.some((x) => x.station.id === c.station.id) || isFastCharger(c.station)));
  const ncSum = nextCharger ? summarize(useChargers.getState().stations.find((x) => x.id === nextCharger.station.id) ?? nextCharger.station) : null;
  const ncIsStop = nextCharger && n.stops.some((x) => x.station.id === nextCharger.station.id);
  const arrival = arrivalStop !== null ? n.stops[arrivalStop.i] : null;
  const arrivalSoc = arrivalStop ? Math.max(0, Math.round(arrivalStop.soc)) : 0;

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 90, background: night ? '#1b1f27' : '#eef2f8' }}>
      <MapView center={plan.input.origin.lngLat} zoom={12} onReady={onMapReady} night={night} />

      {/* Banner de maniobra */}
      {st.started && !st.finished && (
        <div style={{ position: 'absolute', top: 'calc(var(--safe-top) + 12px)', left: 12, right: 12, zIndex: 5 }}>
          <div className="card grad row" style={{ padding: '14px 16px', gap: 14, borderRadius: 24 }}>
            <span style={{ width: 56, height: 56, borderRadius: 18, background: 'rgba(255,255,255,.18)', display: 'grid', placeItems: 'center', flex: 'none' }}>
              <Icon size={34} strokeWidth={2.6} />
            </span>
            <div className="grow">
              <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1 }}>{m ? fmtKm(mDist) : '—'}</div>
              <div className="ellipsis" style={{ fontWeight: 700, fontSize: 14.5, opacity: 0.95, marginTop: 3, whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {st.rerouting ? 'Recalculando ruta…' : m?.instruction ?? 'Sigue la ruta'}
              </div>
            </div>
          </div>
          {nextCharger && ncSum && (
            <div className="card row mt8" style={{ padding: '10px 14px', borderRadius: 18, gap: 10 }}>
              <span className="ic-bubble" style={{ width: 34, height: 34, borderRadius: 11, background: ncIsStop ? 'var(--primary)' : 'var(--primary-soft)', color: ncIsStop ? '#fff' : 'var(--primary)' }}>
                <Zap size={17} />
              </span>
              <div className="grow">
                <div className="bold ellipsis small">
                  {ncIsStop && <span style={{ color: 'var(--primary)' }}>Tu parada · </span>}
                  {shortName(nextCharger.station)}
                </div>
                <div className="tiny muted bold">
                  {fmtKm(nextCharger.alongM - st.along)} · {ncSum.maxDcKw} kW
                </div>
              </div>
              <span className={`badge ${ncSum.state === 'free' ? 'ok' : ncSum.state === 'busy' ? 'warn' : ncSum.state === 'down' ? 'bad' : 'off'}`}>
                <span className="dot" /> {ncSum.free}/{ncSum.total}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Velocidad */}
      {st.started && !st.finished && (
        <div style={{ position: 'absolute', left: 14, bottom: 238, zIndex: 5, width: 66, height: 66, borderRadius: 99, background: '#fff', boxShadow: 'var(--shadow-lg)', display: 'grid', placeItems: 'center', textAlign: 'center' }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{Math.round(st.speedKmh)}</div>
            <div className="tiny muted bold">km/h</div>
          </div>
        </div>
      )}
      {st.started && !st.following && (
        <button className="btn ghost sm" style={{ position: 'absolute', right: 14, bottom: 246, zIndex: 5 }} onClick={() => ((st.following = true), render())}>
          <LocateFixed size={16} /> Recentrar
        </button>
      )}

      {/* Panel inferior */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 6, padding: '0 10px calc(var(--safe-bottom) + 10px)' }}>
        <div className="card" style={{ borderRadius: 28, padding: 16, boxShadow: 'var(--shadow-lg)' }}>
          {!st.started ? (
            <>
              <div className="row" style={{ gap: 14 }}>
                <BatteryRing soc={plan.input.startSoc} size={64} stroke={8} />
                <div className="grow">
                  <div className="bold" style={{ fontSize: 17 }}>
                    {plan.input.origin.name} → {plan.input.destination.name}
                  </div>
                  <div className="small muted">
                    {fmtKm(plan.totals.distanceM)} · {fmtDuration(plan.totals.totalMin)} · {plan.stops.length} {plan.stops.length === 1 ? 'parada' : 'paradas'}
                  </div>
                </div>
              </div>
              <button className="btn primary block mt12" style={{ height: 56 }} onClick={() => begin('gps')}>
                <NavIcon size={20} /> Comenzar con GPS
              </button>
              <div className="grid2 mt8">
                <button className="btn soft" onClick={() => begin('sim')}>
                  <PlayCircle size={18} /> Simular
                </button>
                <button className="btn ghost" onClick={() => setNavigating(false)}>
                  Volver
                </button>
              </div>
              <div className="tiny muted center mt8">“Simular” recorre la ruta solo, para que veas y escuches los avisos.</div>
            </>
          ) : st.finished ? (
            <div className="center">
              <PartyPopper size={40} color="var(--primary)" />
              <div className="bold" style={{ fontSize: 22 }}>
                ¡Llegaste!
              </div>
              <div className="small muted">
                {plan.input.destination.name} · con ≈ {Math.max(0, Math.round(socNow))}% de batería
              </div>
              <button
                className="btn primary block mt16"
                onClick={() => {
                  setNavigating(false);
                }}
              >
                Terminar
              </button>
            </div>
          ) : (
            <>
              <div className="row" style={{ gap: 12 }}>
                <div className="grow">
                  <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.05 }}>{fmtTime(etaAt)}</div>
                  <div className="small muted bold">
                    {fmtDuration(driveLeftS / 60 + chargeLeftMin)} · {fmtKm(remainingM)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <button className="row" style={{ gap: 8 }} onClick={() => (setFixVal(Math.max(0, Math.round(socNow))), setFixOpen(true))}>
                    <div>
                      <div className="tiny muted bold">Batería ahora</div>
                      <div className="bold" style={{ fontSize: 20, color: socColor(socNow) }}>
                        ≈ {Math.max(0, Math.round(socNow))}% <Pencil size={12} className="muted" />
                      </div>
                    </div>
                  </button>
                  <div className="tiny muted bold">
                    {nextStop ? `Parada: ${Math.round(socAtNext ?? 0)}%` : `Llegas: ${Math.round(socArrive)}%`}
                  </div>
                </div>
              </div>
              <div style={{ height: 8, borderRadius: 9, background: 'var(--surface-3)', marginTop: 12, overflow: 'hidden' }}>
                <div style={{ width: `${(st.along / r.distanceM) * 100}%`, height: '100%', background: 'var(--grad)', borderRadius: 9, transition: 'width .3s' }} />
              </div>
              <div className="row mt12" style={{ gap: 8 }}>
                <button className="icon-btn" style={{ background: 'var(--bad-soft)', color: 'var(--bad)', borderColor: 'transparent' }} onClick={() => setNavigating(false)} aria-label="Salir">
                  <X size={20} />
                </button>
                <button
                  className="icon-btn"
                  onClick={() => {
                    settings.set({ voiceOn: !settings.voiceOn });
                    if (settings.voiceOn) stopSpeaking();
                  }}
                  aria-label="Voz"
                >
                  {settings.voiceOn ? <Volume2 size={20} /> : <VolumeX size={20} />}
                </button>
                <button className="btn ghost sm grow" style={{ height: 44 }} onClick={() => setGmapsOpen(true)}>
                  <MapPinned size={17} /> Google Maps
                </button>
                {st.source === 'sim' ? (
                  <button className="btn soft sm" style={{ height: 44 }} onClick={() => ((st.simFactor = st.simFactor >= 48 ? 1 : st.simFactor * 2), render())}>
                    <Gauge size={16} /> {st.simFactor}×
                  </button>
                ) : (
                  <button className="icon-btn" onClick={() => ((st.following = true), render())} aria-label="Centrar">
                    <Crosshair size={20} />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Llegada a una parada */}
      <Sheet open={!!arrival} onClose={continueAfterStop}>
        {arrival && (
          <>
            <div className="center">
              <span className="ic-bubble" style={{ width: 64, height: 64, borderRadius: 22, background: 'var(--grad)', color: '#fff', margin: '0 auto' }}>
                <BatteryCharging size={32} />
              </span>
              <h3 style={{ fontSize: 21, fontWeight: 800, marginTop: 10 }}>Llegaste a tu parada</h3>
              <div className="ink2 bold">{shortName(arrival.station)}</div>
              <div className="small muted">{arrival.station.operator}</div>
            </div>
            <div className="grid3 mt16">
              <div className="stat center">
                <div className="k" style={{ justifyContent: 'center' }}>Cargar de</div>
                <div className="v">{arrivalSoc}%</div>
              </div>
              <div className="stat center">
                <div className="k" style={{ justifyContent: 'center' }}>Hasta</div>
                <div className="v">{arrival.departSoc}%</div>
              </div>
              <div className="stat center">
                <div className="k" style={{ justifyContent: 'center' }}>Tiempo</div>
                <div className="v">{Math.round(arrival.chargeMin)}′</div>
              </div>
            </div>
            <button
              className="btn primary block mt16"
              onClick={() => {
                const sum = summarize(arrival.station);
                saveProgress();
                openTimer({ startSoc: arrivalSoc, targetSoc: arrival.departSoc, kw: arrival.kw, type: 'DC', price: sum.priceDc, stationName: shortName(arrival.station) });
              }}
            >
              <Timer size={18} /> Cronometrar esta carga
            </button>
            <button className="btn ghost block mt8" onClick={continueAfterStop}>
              Seguir navegando
            </button>
          </>
        )}
      </Sheet>

      {/* Corregir batería */}
      <Sheet open={fixOpen} onClose={() => setFixOpen(false)}>
        <h3 style={{ fontSize: 19, fontWeight: 800 }}>¿Qué % muestra tu auto?</h3>
        <div className="small muted">Recalculo la llegada con tu batería real.</div>
        <div className="mt16" />
        <RangeField label="Batería real" value={fixVal} min={0} max={100} unit="%" onChange={setFixVal} />
        <button
          className="btn primary block mt16"
          onClick={() => {
            st.socOffset += fixVal - socNow;
            setFixOpen(false);
            saveProgress();
            render();
          }}
        >
          Corregir
        </button>
      </Sheet>

      {/* Abrir Google Maps */}
      <Sheet open={gmapsOpen} onClose={() => setGmapsOpen(false)}>
        <h3 style={{ fontSize: 19, fontWeight: 800 }}>Navegar con Google Maps</h3>
        <div className="small ink2 mt8">
          Se abrirá Google Maps con tus paradas de carga. <b>Luego vuelve a MiAutito</b> y déjala en pantalla: Google Maps te guía por voz en segundo plano y yo te aviso de los cargadores y la batería.
        </div>
        <div className="small ink2 mt8">Apagaré mis indicaciones de giro para que no se repitan.</div>
        <a
          className="btn primary block mt16"
          style={{ textDecoration: 'none' }}
          href={plan ? googleMapsUrl({ ...plan, stops: pendingStops }, st.pos) : '#'}
          target="_blank"
          rel="noreferrer"
          onClick={() => {
            settings.set({ voiceTurns: false });
            setGmapsOpen(false);
          }}
        >
          <MapPinned size={18} /> Abrir Google Maps
        </a>
        {!settings.voiceTurns && (
          <button className="btn ghost block mt8" onClick={() => settings.set({ voiceTurns: true })}>
            Volver a activar mis indicaciones de giro
          </button>
        )}
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------

function socAt(n: NavRoute, idx: number, along: number): number {
  const r = n.route;
  const i = Math.max(0, Math.min(idx, r.coords.length - 2));
  const seg = r.cum[i + 1] - r.cum[i];
  const t = seg > 0 ? Math.max(0, Math.min(1, (along - r.cum[i]) / seg)) : 0;
  return n.soc[i] + (n.soc[i + 1] - n.soc[i]) * t;
}

/** En tramos hacia una parada, Valhalla dice "su destino": lo cambiamos por "tu parada de carga" */
function stopWording(text: string, isStopLeg: boolean) {
  return isStopLeg ? text.replace(/su destino/gi, 'tu parada de carga') : text;
}

/** Índice del vértice de la ruta en la distancia `along` (búsqueda binaria) */
function idxAt(cum: number[], along: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= along) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** % estimado al llegar a una distancia `along` (antes de cargar ahí) */
function estimateSocAt(n: NavRoute, along: number): number {
  // el vértice exacto de la parada ya tiene el % de salida; usamos el anterior
  const i = idxAt(n.route.cum, along - 1);
  return n.soc[Math.max(0, i)];
}

function nextManeuverIndex(n: NavRoute, along: number): number {
  const ms = n.route.maneuvers;
  for (let i = 0; i < ms.length; i++) {
    if (ms[i].alongM > along + 3) return i;
  }
  return -1;
}
