import { useEffect } from 'react';
import { useTimer, sessionState } from '../store/timer';
import { chime, notify, speak, vibrate } from '../lib/voice';
import { useUi } from '../store/ui';

/** Revisa la carga activa cada pocos segundos y avisa al llegar a cada % (en cualquier pantalla). */
export default function TimerWatcher() {
  useEffect(() => {
    const tick = () => {
      const { session, markNotified, finish } = useTimer.getState();
      if (!session || session.finishedAt) return;
      const st = sessionState(session);
      const goals = [...new Set([...session.milestones.filter((m) => m > session.startSoc && m < session.targetSoc), session.targetSoc])].sort((a, b) => a - b);
      for (const g of goals) {
        if (session.notified.includes(g)) continue;
        if (st.soc + 0.05 >= g) {
          markNotified(g);
          const isTarget = g === session.targetSoc;
          const msg = isTarget
            ? `¡Listo! Tu auto debería estar en ${g} por ciento. Ya puedes desconectar.`
            : `Tu auto debería ir en ${g} por ciento. Faltan unos ${Math.max(1, Math.round(st.totalMin - st.minuteFor(g)))} minutos para el ${session.targetSoc}.`;
          chime(isTarget ? 'done' : 'soft');
          vibrate(isTarget ? [300, 120, 300, 120, 500] : [200, 100, 200]);
          speak(msg, { priority: true });
          notify(isTarget ? `🔋 ¡Carga lista! ${g}%` : `🔋 Vas en ${g}%`, isTarget ? 'Ya puedes desconectar tu Ora 5' : `Objetivo: ${session.targetSoc}%`, 'charge');
          useUi.getState().showToast(isTarget ? `¡Carga lista! ${g}%` : `Batería ≈ ${g}%`);
          if (isTarget) finish();
        }
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    const onVis = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  return null;
}
