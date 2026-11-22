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
  WifiOff,
} from 'lucide-react';
import MapView, { drawChargerDots, drawRoute, fitTo, htmlMarker, isNight, maplibregl } from '../components/MapView';
import BatteryRing from '../components/BatteryRing';
import { RangeField, Sheet, socColor } from '../components/ui';
import { useTrip } from '../store/trip';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { useChargers, summarize, STATE_COLOR, shortName, expectedWaitMin, type Station } from '../lib/chargers';
import { chargeMinutes } from '../lib/car';
import type { PlannedStop } from '../lib/planner';
import { loadTolls, tollPriceAt, tollsOnRoute, type OdSystem, type TollHit, type TollPoint } from '../lib/tolls';
import { bearing, pointAt, snapToRoute, haversine, type LngLat } from '../lib/geo';
import { getRoute, maneuverIcon, fetchLanes, laneHint, ARRIVE_TYPES, type Lane, type Maneuver } from '../lib/routing';
import { chargersAlong, googleMapsUrl } from '../lib/planner';
import { chargerAlertText, farText, isFastCharger, maneuverThresholds, navFromPlan, rebuildNav, spokenName, type NavRoute } from '../lib/nav';
import { chime, keepScreenOn, speak, unlockSpeech, vibrate, ensureNotifications, notify, stopSpeaking } from '../lib/voice';
import { downloadRoute, isDownloaded } from '../lib/offlineMap';
import { optionTitle } from '../lib/routeChoice';
import { loadTimedStreets, streetNames, timeAlong, wrongWays } from '../lib/timedStreets';
import { fmtCLP, fmtDuration, fmtKm, fmtTime, speakDistance } from '../lib/format';

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
  /** última lectura GPS precisa (≤ 45 m) */
  lastGoodFix: number;
  /** velocidad de la última lectura precisa (km/h) */
  gpsSpeed: number;
  /** sin GPS (túnel): avanzamos por la ruta a la última velocidad conocida */
  dr: boolean;
  drStart: number;
  drAlong0: number;
  drLast: number;
  /** no evaluar "fuera de ruta" hasta este momento (recién salimos de un túnel / sin internet) */
  graceUntil: number;
  offlineNotified: boolean;
}

/** Hasta dónde estimar la posición sin GPS (los túneles largos de Santiago tienen ~4 km) */
const DR_MAX_MS = 4 * 60000;
const DR_MAX_M = 5000;
/** lecturas peores que esto no se usan para decidir si nos salimos de la ruta */
const GOOD_ACC_M = 45;

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
  const [swap, setSwap] = useState<{ stopIdx: number; alt: Station; altSoc: number; reason: string; detail: string } | null>(null);

  const mapRef = useRef<MlMap | null>(null);
  const puck = useRef<Marker | null>(null);
  const markers = useRef<Marker[]>([]);
  const nav = useRef<NavRoute | null>(plan ? navFromPlan(plan) : null);
  const watchId = useRef<number | null>(null);
  const simTimer = useRef<number | null>(null);
  const lastChargerSpeech = useRef(0);
  const tollList = useRef<TollPoint[]>([]);
  const odList = useRef<OdSystem[]>([]);
  const tollHits = useRef<TollHit[]>([]);
  const computeTolls = () => {
    const n = nav.current;
    if (!n || !tollList.current.length) return;
    tollHits.current = tollsOnRoute(n.route, tollList.current, (a) => Date.now() + (n.route.cumT[idxAt(n.route.cum, a)] ?? 0) * 1000, odList.current).hits;
  };
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
    lastGoodFix: 0,
    gpsSpeed: 0,
    dr: false,
    drStart: 0,
    drAlong0: 0,
    drLast: 0,
    graceUntil: 0,
    offlineNotified: false,
  });
  const arrivalOpen = useRef(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    arrivalOpen.current = arrivalStop !== null;
  }, [arrivalStop]);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);

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
    (pos: LngLat, speedKmh: number, heading: number | null, known?: { along: number; idx: number }, accuracy = 20) => {
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
        const wasDr = st.dr;
        // al salir de un túnel buscamos más adelante (la estimación pudo quedarse corta)
        const snap = snapToRoute(pos, r.coords, r.cum, fresh ? st.idx : undefined, wasDr ? 80 : 30, wasDr ? 1200 : 400);
        along = snap.along;
        idx = snap.index;
        if (accuracy <= GOOD_ACC_M) {
          st.lastGoodFix = now;
          st.gpsSpeed = speedKmh;
          if (wasDr) {
            // volvió el GPS: las primeras lecturas suelen venir corridas, damos unos segundos antes de recalcular
            st.dr = false;
            st.graceUntil = now + 20000;
          }
        }
        // ¿fuera de ruta? Solo con GPS preciso, varios segundos seguidos y fuera del período de gracia
        const offLimit = Math.max(70, accuracy * 1.5);
        if (snap.dist > offLimit && accuracy <= 35) {
          if (!st.offSince) st.offSince = now;
          if (now - st.offSince > 12000 && now > st.graceUntil && !st.rerouting) reroute(pos);
        } else if (snap.dist <= offLimit) st.offSince = 0;
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
          // si no alcanzó a sonar el aviso anticipado, la pista va en este
          const hint = !st.fired.has(`${key}-far`) ? laneHint(m.lanes) : null;
          st.fired.add(`${key}-near`).add(`${key}-far`);
          speak(stopWording(m.pre ?? m.instruction, m.leg < r.legEnds.length - 1) + (hint ? `. Usa ${hint}.` : ''));
        } else if (dist <= th.far && dist > th.near * 1.8 && !st.fired.has(`${key}-far`)) {
          st.fired.add(`${key}-far`);
          // con las pistas de OpenStreetMap: "Usa las 2 pistas de la derecha"
          const hint = laneHint(m.lanes);
          speak(stopWording(farText(m, Math.round(dist / 50) * 50), m.leg < r.legEnds.length - 1) + (hint ? `. Usa ${hint}.` : ''));
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
                const num = stop ? plan.stops.findIndex((p) => p.station.id === rc.station.id) + 1 || n.stops.indexOf(stop) + 1 + st.arrived.size : undefined;
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

      // 4a) plazas de peaje a 1 km (los pórticos TAG no se anuncian: son demasiados)
      if (voice.voiceOn) {
        for (const h of tollHits.current) {
          if (h.toll.kind === 'portico') continue;
          const d = h.alongM - along;
          const key = `t-${h.toll.name}-${Math.round(h.alongM / 1000)}`;
          if (d > 0 && d <= 1000 && !st.fired.has(key)) {
            st.fired.add(key);
            if (d > 250) {
              const { price } = tollPriceAt(h.toll, new Date(now + (d / Math.max(5, speedKmh / 3.6)) * 1000));
              speak(`Peaje ${h.toll.name} en ${speakDistance(Math.round(d / 100) * 100)}: ${price} pesos.`);
            }
          }
        }
      }

      // 4b) revisar en vivo la próxima parada (a ~25 km y de nuevo a ~6 km)
      const nextIdx = n.stops.findIndex((x) => !st.arrived.has(x.station.id) && x.navAlong > along);
      if (nextIdx >= 0) {
        const stop = n.stops[nextIdx];
        const dist = stop.navAlong - along;
        const key = dist <= 6000 ? `chk2-${stop.station.id}` : dist <= 25000 ? `chk1-${stop.station.id}` : null;
        if (key && !st.fired.has(key)) {
          st.fired.add(key);
          if (key.startsWith('chk2')) st.fired.add(`chk1-${stop.station.id}`);
          checkStop(nextIdx, along, idx);
        }
      }

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

  async function reroute(pos: LngLat, override?: PlannedStop[], message = 'Recalculando ruta.') {
    const st = s.current;
    const n = nav.current;
    if (!plan || !n) return;
    // Sin internet no se puede recalcular: mantener la ruta y las indicaciones (no "volverse loco")
    if (!navigator.onLine) {
      st.offSince = 0;
      st.graceUntil = Date.now() + 60000;
      if (!st.offlineNotified) {
        st.offlineNotified = true;
        speak('Estás sin internet, así que no puedo recalcular. Sigo con la ruta planificada: vuelve a ella cuando puedas.');
      }
      render();
      return;
    }
    st.rerouting = true;
    render();
    speak(message);
    try {
      const remaining = override ?? n.stops.filter((x) => !st.arrived.has(x.station.id) && x.navAlong > st.along);
      const pts: LngLat[] = [pos, ...remaining.map((x) => [x.station.lng, x.station.lat] as LngLat), plan.input.destination.lngLat];
      // mismo tipo de ruta que eligió (sin peajes, sin TAG, económica…)
      const route = await getRoute(pts, {
        topSpeed: plan.input.cruiseKmh,
        ...(plan.routeSpec ?? { excludeTolls: plan.input.avoidTolls }),
        // a la hora de ahora: calles reversibles, vías exclusivas…
        departAt: Date.now(),
        legDelayMin: remaining.map((x) => x.chargeMin + 5),
      });
      const socNow = socAt(n, st.idx, st.along) + st.socOffset;
      nav.current = rebuildNav(plan, route, socNow, remaining, chargersAlong(route, useChargers.getState().stations));
      st.socOffset = 0;
      st.along = 0;
      st.idx = 0;
      st.offSince = 0;
      computeTolls();
      // pistas de la nueva ruta (en segundo plano)
      fetchLanes(route).then(render).catch(() => {});
      for (const k of [...st.fired]) if (k.startsWith('m-')) st.fired.delete(k);
      drawAll();
    } catch {
      // sin señal de datos (túnel, zona rural): seguimos con la ruta que teníamos
      st.offSince = 0;
      st.graceUntil = Date.now() + 45000;
      showToast('Sin conexión: sigo con la ruta planificada');
    } finally {
      st.rerouting = false;
      render();
    }
  }

  /** Revisa el estado en vivo de una parada próxima y, si conviene, propone el plan B */
  function checkStop(stopIdx: number, along: number, idx: number) {
    const n = nav.current;
    const st = s.current;
    if (!n || !plan) return;
    const r = n.route;
    const stop = n.stops[stopIdx];
    const all = useChargers.getState().stations;
    const byId = new Map(all.map((x) => [x.id, x]));
    const liveStop = byId.get(stop.station.id) ?? stop.station;
    const etaStop = Math.max(0, (r.cumT[idxAt(r.cum, stop.navAlong)] - r.cumT[idx]) / 60);
    const waitStop = expectedWaitMin(liveStop, etaStop);
    if (waitStop < 8) return; // todo bien (o se libera pronto)

    const sum = summarize(liveStop);
    const reason = !isFinite(waitStop)
      ? 'está fuera de servicio'
      : sum.dcBusy > 0
        ? sum.busyLongestMin !== undefined && sum.busyLongestMin < 2
          ? 'se acaba de ocupar'
          : `está ocupada${sum.busyLongestMin !== undefined ? ` desde hace ${Math.round(sum.busyLongestMin)} minutos` : ''}`
        : 'no está informando su estado';
    const num = plan.stops.findIndex((p) => p.station.id === stop.station.id) + 1 || stopIdx + 1 + st.arrived.size;

    // candidatos: plan B guardado + cargadores rápidos en la ruta cerca de la parada
    const cands = (stop.alternates ?? []).map((a) => ({ station: byId.get(a.station.id) ?? a.station, delta: a.alongM }));
    for (const rc of n.chargers) {
      const d = rc.alongM - stop.navAlong;
      if (Math.abs(d) <= 30000 && rc.station.id !== stop.station.id && isFastCharger(rc.station) && !cands.some((c) => c.station.id === rc.station.id))
        cands.push({ station: byId.get(rc.station.id) ?? rc.station, delta: d });
    }
    const cap = plan.input.usableKwh;
    const arriveStop = estimateSocAt(n, stop.navAlong) + st.socOffset;
    let best: { station: Station; delta: number; w: number; soc: number; score: number } | null = null;
    for (const c of cands) {
      const altAlong = stop.navAlong + c.delta;
      if (altAlong < along + 1500) continue; // ya lo pasamos
      // antes de la parada vale el perfil de batería (sin la carga de la parada); después, se descuenta lo extra
      const soc = c.delta <= 0 ? estimateSocAt(n, altAlong) + st.socOffset : arriveStop - ((c.delta / 1000) * 0.19 / cap) * 100;
      if (soc < 6) continue;
      const eta = Math.max(0, (r.cumT[idxAt(r.cum, Math.min(altAlong, r.distanceM))] - r.cumT[idx]) / 60);
      const w = expectedWaitMin(c.station, eta);
      if (!isFinite(w)) continue;
      const score = w + (Math.abs(c.delta) / 1000) * 0.5;
      if (!best || score < best.score) best = { ...c, w, soc, score };
    }

    if (best && best.w < waitStop - 5) {
      const asum = summarize(best.station);
      const km = Math.round(Math.abs(best.delta) / 1000);
      const where = km < 1 ? 'muy cerca' : `${km} kilómetros ${best.delta < 0 ? 'antes' : 'después'}`;
      const free = asum.dcFree > 0 ? `con ${asum.dcFree} ${asum.dcFree === 1 ? 'cargador libre' : 'cargadores libres'}` : 'con buena probabilidad de estar libre';
      chime('alert');
      vibrate([200, 100, 200]);
      speak(`Atención: tu parada ${num}, ${spokenName(liveStop)}, ${reason}. Una alternativa es ${spokenName(best.station)}, ${where}, ${free}. Toca cambiar parada si quieres ir ahí.`, { priority: true });
      setSwap({
        stopIdx,
        alt: best.station,
        altSoc: best.soc,
        reason: `Tu parada ${num} ${reason}.`,
        detail: `${shortName(best.station)} · ${km < 1 ? 'muy cerca' : `${km} km ${best.delta < 0 ? 'antes' : 'después'}`} · ${Math.min(120, asum.maxDcKw)} kW · ${asum.dcFree > 0 ? `${asum.dcFree} libres` : 'sin datos recientes'}`,
      });
    } else if (sum.dcBusy > 0 && sum.nextFreeMin !== undefined) {
      speak(`Tu parada ${num}, ${spokenName(liveStop)}, ${reason}. Debería liberarse en unos ${Math.round(Math.max(3, sum.nextFreeMin - etaStop))} minutos.`);
    } else {
      speak(`Ojo: tu parada ${num}, ${spokenName(liveStop)}, ${reason}. Revisa el plan B en la app.`);
    }
  }

  /** Cambia una parada por la alternativa propuesta y recalcula la ruta */
  function applySwap() {
    const st = s.current;
    const n = nav.current;
    if (!swap || !n || !plan || !st.pos) return;
    const old = n.stops[swap.stopIdx];
    const sum = summarize(swap.alt);
    const kw = Math.min(sum.maxDcKw || 50, 120);
    const delta = (old.alternates ?? []).find((a) => a.station.id === swap.alt.id)?.alongM ?? 0;
    // si la alternativa queda antes, el siguiente tramo es más largo: cargar un poco más
    const extra = delta < 0 ? Math.ceil(((Math.abs(delta) / 1000) * 0.19 / plan.input.usableKwh) * 100) : 0;
    const departSoc = Math.min(95, old.departSoc + extra);
    const remaining = n.stops
      .filter((x) => !st.arrived.has(x.station.id) && x.navAlong > st.along)
      .map((x) =>
        x === old
          ? {
              ...x,
              station: swap.alt,
              kw,
              departSoc,
              chargeMin: chargeMinutes(Math.max(0, swap.altSoc), departSoc, kw, 'DC', (plan.input.tempOrigin + plan.input.tempDest) / 2, plan.input.usableKwh),
              alternates: [{ station: old.station, alongM: -delta, offsetM: 0 }],
            }
          : x,
      );
    setSwap(null);
    reroute(st.pos, remaining, `Listo, cambio tu parada a ${spokenName(swap.alt)}.`);
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
        const st = s.current;
        const acc = p.coords.accuracy;
        if (acc > 120) return; // lectura muy imprecisa
        // En túneles el GPS se pierde o "salta" con lecturas malas: mientras tanto seguimos
        // estimando la posición sobre la ruta en vez de creer que nos salimos
        if (acc > GOOD_ACC_M && (st.dr || Date.now() - st.lastGoodFix < 15000)) return;
        const speed = p.coords.speed != null && p.coords.speed >= 0 ? p.coords.speed * 3.6 : st.speedKmh;
        const heading = p.coords.heading != null && !isNaN(p.coords.heading) && speed > 6 ? p.coords.heading : null;
        update([p.coords.longitude, p.coords.latitude], speed, heading, undefined, acc);
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
    // pistas y letreros de salida (en segundo plano; si no hay internet se navega igual)
    if (navigator.onLine && !n.route.maneuvers.some((x) => x.lanes)) fetchLanes(n.route).then(render).catch(() => {});
    if (source === 'gps') startGps();
    else startSim();
    // guardar el mapa del camino por si se pierde la señal (lo ya guardado no se vuelve a bajar)
    if (navigator.onLine && !isDownloaded(plan!.id) && n.route.distanceM < 250000) downloadRoute(plan!.id, n.route.coords).catch(() => {});
    void checkTimedNow();
  }

  /**
   * El plan pudo calcularse para otra hora (ruta guardada, "Seguir viaje"): revisar las calles
   * reversibles a la hora real y, si alguna va en contra, recalcular (o avisar si no hay internet).
   */
  async function checkTimedNow() {
    const idx = await loadTimedStreets();
    const n = nav.current;
    const st = s.current;
    if (!idx || !n || !plan) return;
    const r = n.route;
    const departAt = Date.now() - (r.cumT[st.idx] ?? 0) * 1000;
    const bad = wrongWays(r, idx, timeAlong(r, departAt, n.stops.map((x) => x.chargeMin + 5))).filter(
      (w) => w.alongM > st.along + 150 && w.alongM < r.distanceM - 150,
    );
    if (!bad.length) return;
    const names = streetNames(bad);
    const what = names.length ? names.join(', ') : 'una calle de tu ruta';
    if (!navigator.onLine) {
      speak(`Ojo: a esta hora ${what} tiene otro sentido de tránsito. Sin internet no puedo cambiar la ruta: respeta la señalización.`, { priority: true });
      return;
    }
    const pos = st.pos ?? pointAt(r.coords, r.cum, st.along).point;
    reroute(pos, undefined, `A esta hora ${what} cambia de sentido. Ajusto la ruta.`);
  }

  // Sin GPS (túnel): avanzar por la ruta a la última velocidad para que los avisos de salida sigan llegando
  useEffect(() => {
    const id = window.setInterval(() => {
      const st = s.current;
      const n = nav.current;
      if (!st.started || st.finished || st.source !== 'gps' || !n || st.rerouting || arrivalOpen.current) return;
      const now = Date.now();
      if (!st.lastGoodFix || now - st.lastGoodFix < 3500 || st.gpsSpeed < 12) {
        if (st.dr && now - st.lastGoodFix < 3500) st.dr = false;
        return;
      }
      if (!st.dr) {
        st.dr = true;
        st.drStart = now;
        st.drAlong0 = st.along;
        st.drLast = now;
        render();
        return;
      }
      const dt = (now - st.drLast) / 1000;
      st.drLast = now;
      // túnel muy largo o auto detenido adentro: dejamos de avanzar y esperamos al GPS
      if (now - st.drStart > DR_MAX_MS || st.along - st.drAlong0 > DR_MAX_M) return;
      const r = n.route;
      // la última velocidad real (en un túnel se suele mantener); tope por el tipo de vía para no adelantarse
      // demasiado. Mejor avisar una salida un poco antes que tarde.
      const v = Math.min(st.gpsSpeed, Math.max(40, (r.speed[st.idx] ?? st.gpsSpeed) * 1.5));
      const along = Math.min(r.distanceM - 1, st.along + (v / 3.6) * dt);
      const { point, index } = pointAt(r.coords, r.cum, along);
      const ahead = pointAt(r.coords, r.cum, along + 35).point;
      update(point, v, bearing(point, ahead), { along, idx: index });
    }, 1000);
    return () => window.clearInterval(id);
  }, [update]);

  // Para pruebas en desarrollo
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __nav: unknown }).__nav = { s, nav, update };
  }, [update]);

  useEffect(() => {
    loadTolls().then((d) => {
      tollList.current = d?.tolls ?? [];
      odList.current = d?.od ?? [];
      computeTolls();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // datos en vivo: cada 4 min cerca de una parada (≤50 km), si no cada 15 min (cada descarga pesa ~3 MB)
  useEffect(() => {
    const id = window.setInterval(() => {
      const st = s.current;
      const n = nav.current;
      if (!st.started || st.finished || !n || document.visibilityState !== 'visible') return;
      const next = n.stops.find((x) => !st.arrived.has(x.station.id) && x.navAlong > st.along);
      const close = !!next && next.navAlong - st.along < 50000;
      const age = Date.now() - useChargers.getState().updatedAt;
      if (age > (close ? 4 : 15) * 60000) useChargers.getState().refresh(true);
    }, 60000);
    return () => window.clearInterval(id);
  }, []);

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
          {m && !st.rerouting && <ManeuverExtras m={m} dist={mDist} />}
          {(st.dr || !online) && st.source === 'gps' && (
            <div className="row mt8" style={{ gap: 6, flexWrap: 'wrap' }}>
              {st.dr && (
                <span className="badge warn" style={{ background: '#fff', boxShadow: 'var(--shadow)' }}>
                  <span className="dot" /> Sin GPS (¿túnel?) · estimando tu posición
                </span>
              )}
              {!online && (
                <span className="badge off" style={{ background: '#fff', boxShadow: 'var(--shadow)' }}>
                  <WifiOff size={12} /> Sin internet · sigo la ruta guardada
                </span>
              )}
            </div>
          )}
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
                  {plan.routeOptions && plan.routeOptions.length > 0 && (
                    <div className="tiny bold" style={{ color: 'var(--primary)' }}>
                      Ruta {optionTitle(plan.routeOptions.find((o) => o.key === plan.routeKey) ?? plan.routeOptions[0]).toLowerCase()} ·{' '}
                      {plan.totals.tollClp ? `peajes y TAG ${fmtCLP(plan.totals.tollClp)}` : 'sin peajes'}
                    </div>
                  )}
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

      {/* Propuesta de plan B */}
      <Sheet open={!!swap} onClose={() => setSwap(null)}>
        {swap && (
          <>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <span className="ic-bubble" style={{ background: 'var(--warn-soft)', color: '#C27803' }}>
                <Zap size={20} />
              </span>
              <div className="grow">
                <h3 style={{ fontSize: 19, fontWeight: 800 }}>¿Cambiar de parada?</h3>
                <div className="small ink2">{swap.reason}</div>
              </div>
            </div>
            <div className="card soft mt12" style={{ padding: 14 }}>
              <div className="tiny bold muted">ALTERNATIVA</div>
              <div className="bold mt8">{swap.detail}</div>
              <div className="tiny muted mt8">Llegarías con ≈ {Math.max(0, Math.round(swap.altSoc))}% de batería.</div>
            </div>
            <button className="btn primary block mt16" onClick={applySwap}>
              <Zap size={18} /> Cambiar parada
            </button>
            <button className="btn ghost block mt8" onClick={() => setSwap(null)}>
              Mantener mi parada
            </button>
          </>
        )}
      </Sheet>

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

const LANE_ICON: Record<string, typeof ArrowUp> = {
  straight: ArrowUp,
  right: CornerUpRight,
  'sharp right': CornerUpRight,
  'slight right': ArrowUpRight,
  left: CornerUpLeft,
  'sharp left': CornerUpLeft,
  'slight left': ArrowUpLeft,
  uturn: Undo2,
  'merge to left': Merge,
  'merge to right': Merge,
};

/** Letrero verde de salida y pistas a usar, como en las autopistas */
function ManeuverExtras({ m, dist }: { m: Maneuver; dist: number }) {
  const showSign = !!m.sign && dist < (m.highway ? 4000 : 1200);
  const showLanes = !!m.lanes && dist < (m.highway || m.sign ? 2500 : 700);
  if (!showSign && !showLanes) return null;
  const where = [...(m.sign?.branch ?? []), ...(m.sign?.toward ?? [])].filter((x, i, a) => a.indexOf(x) === i);
  return (
    <div className="mt8" style={{ display: 'grid', gap: 6 }}>
      {showSign && (where.length > 0 || m.sign?.exit) && (
        <div className="exit-sign">
          {m.sign?.exit && <span className="exit-num">Salida {m.sign.exit}</span>}
          <span className="exit-to">{where.length ? where.join(' · ') : m.sign?.name}</span>
        </div>
      )}
      {showLanes && <LaneStrip lanes={m.lanes!} />}
    </div>
  );
}

function LaneStrip({ lanes }: { lanes: Lane[] }) {
  const anyBest = lanes.some((l) => l.best);
  return (
    <div className="lane-strip" aria-label="Pistas">
      {lanes.map((l, i) => {
        const good = anyBest ? l.best : l.ok;
        const ind = (good ? l.use : undefined) ?? l.ind.find((x) => x !== 'none') ?? 'straight';
        const Icon = LANE_ICON[ind] ?? ArrowUp;
        return (
          <span key={i} className={`lane ${good ? 'on' : ''}`}>
            <Icon size={24} strokeWidth={good ? 3 : 2.4} />
          </span>
        );
      })}
    </div>
  );
}

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
