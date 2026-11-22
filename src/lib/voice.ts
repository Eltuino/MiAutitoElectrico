import { useSettings } from '../store/settings';

let voice: SpeechSynthesisVoice | null = null;
let voicesLoaded = false;

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  voicesLoaded = true;
  const prefs = ['es-CL', 'es-419', 'es-US', 'es-MX', 'es-AR', 'es-ES', 'es'];
  for (const p of prefs) {
    const v =
      voices.find((v) => v.lang.toLowerCase() === p.toLowerCase() && /google|natural|online|enhanced|premium/i.test(v.name)) ??
      voices.find((v) => v.lang.toLowerCase().startsWith(p.toLowerCase()));
    if (v) {
      voice = v;
      return;
    }
  }
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

/** Habla un texto. `priority` interrumpe lo que se esté diciendo. */
export function speak(text: string, opts: { priority?: boolean; force?: boolean } = {}) {
  const s = useSettings.getState();
  if (!canSpeak() || (!s.voiceOn && !opts.force)) return;
  if (!voicesLoaded) pickVoice();
  if (opts.priority) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voice?.lang ?? 'es-CL';
  if (voice) u.voice = voice;
  u.rate = s.voiceRate;
  u.pitch = 1;
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (canSpeak()) speechSynthesis.cancel();
}

/** En iOS la voz debe "desbloquearse" con un toque del usuario */
export function unlockSpeech() {
  if (!canSpeak()) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------------------
// Notificaciones, vibración y pantalla encendida
// ---------------------------------------------------------------------------

export async function ensureNotifications(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

export async function notify(title: string, body: string, tag?: string) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts: NotificationOptions & { vibrate?: number[] } = { body, tag, icon: `${import.meta.env.BASE_URL}icons/icon-192.png`, badge: `${import.meta.env.BASE_URL}icons/icon-192.png`, vibrate: [200, 100, 200] };
    if (reg) await reg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch {
    /* ignorar */
  }
}

export function vibrate(pattern: number | number[] = [180, 80, 180]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* ignorar */
  }
}

let wakeLock: WakeLockSentinel | null = null;
let wantWake = false;

export async function keepScreenOn(on: boolean) {
  wantWake = on;
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* sin soporte o sin permiso */
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wantWake) keepScreenOn(true);
  });
}

/** Sonido corto tipo "ding" con WebAudio (no necesita archivos) */
export function chime(kind: 'soft' | 'alert' | 'done' = 'soft') {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    const notes = kind === 'done' ? [660, 880, 1320] : kind === 'alert' ? [880, 660] : [880];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch {
    /* ignorar */
  }
}
