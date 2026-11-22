import { lazy, Suspense, useEffect } from 'react';
import { BatteryCharging, Home as HomeIcon, MapPin, Route, Settings as SettingsIcon, Info } from 'lucide-react';
import { useUi, type Tab } from './store/ui';
import { useChargers } from './lib/chargers';
import { useTimer, sessionState } from './store/timer';
import Home from './screens/Home';
import PlanTrip from './screens/PlanTrip';
import Chargers from './screens/Chargers';
import ChargeTimer from './screens/ChargeTimer';
import Settings from './screens/Settings';
import TimerWatcher from './components/TimerWatcher';

const Navigate = lazy(() => import('./screens/Navigate'));

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'home', label: 'Inicio', icon: <HomeIcon size={21} /> },
  { id: 'trip', label: 'Viaje', icon: <Route size={21} /> },
  { id: 'chargers', label: 'Cargadores', icon: <MapPin size={21} /> },
  { id: 'timer', label: 'Carga', icon: <BatteryCharging size={21} /> },
  { id: 'settings', label: 'Ajustes', icon: <SettingsIcon size={21} /> },
];

export default function App() {
  const { tab, go, navigating, toast } = useUi();
  const refresh = useChargers((s) => s.refresh);
  const session = useTimer((s) => s.session);
  const charging = session && !sessionState(session).done;

  // Estado en vivo de cargadores: al abrir la app y al volver a ella (si tiene más de 3 min),
  // y cada 5 min solo mientras miras Cargadores o tu viaje. El modo viaje maneja su propio ritmo.
  useEffect(() => {
    refresh();
    const onVis = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  useEffect(() => {
    if (navigating || (tab !== 'chargers' && tab !== 'trip')) return;
    refresh();
    const id = setInterval(() => document.visibilityState === 'visible' && refresh(true), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [tab, navigating, refresh]);

  return (
    <div className="app">
      {tab === 'home' && <Home />}
      {tab === 'trip' && <PlanTrip />}
      {tab === 'chargers' && <Chargers />}
      {tab === 'timer' && <ChargeTimer />}
      {tab === 'settings' && <Settings />}

      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => go(t.id)}>
            <span className="tab-ic" style={{ position: 'relative' }}>
              {t.icon}
              {t.id === 'timer' && charging && (
                <span className="pulse" style={{ position: 'absolute', top: 3, right: 8, width: 8, height: 8, borderRadius: 9, background: 'var(--ok)' }} />
              )}
            </span>
            {t.label}
          </button>
        ))}
      </nav>

      {navigating && (
        <Suspense fallback={null}>
          <Navigate />
        </Suspense>
      )}

      <TimerWatcher />

      {toast && (
        <div className="toast" key={toast.id}>
          <Info size={18} /> {toast.text}
        </div>
      )}
    </div>
  );
}
