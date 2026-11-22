import { useEffect, useMemo, useState } from 'react';
import { Car, Info, Volume2, Wallet, Gauge, Smartphone, Database, Play, Bookmark, Trash2, CloudOff, Download, Loader2 } from 'lucide-react';
import { RangeField, Toggle, Segmented } from '../components/ui';
import { ORA5 } from '../lib/car';
import { useSettings } from '../store/settings';
import { useSaved } from '../store/saved';
import { useUi } from '../store/ui';
import { SAVED_ICON } from '../components/icons';
import { ROUTE_PREFS, type RoutePref } from '../lib/routeChoice';
import { clearOffline, downloadTiles, offlineUsage, tilesInBox, SANTIAGO_BOX, type DownloadProgress } from '../lib/offlineMap';
import { speak, unlockSpeech } from '../lib/voice';
import { fmtCLP } from '../lib/format';
import { useChargers, priceStats } from '../lib/chargers';
import { kwhPerKm } from '../lib/energy';

export default function Settings() {
  const s = useSettings();
  const { stations, source, updatedAt } = useChargers();
  const live = useMemo(() => priceStats(stations), [stations]);
  const [realKmKwh, setRealKmKwh] = useState(6.5);
  const [kind, setKind] = useState<'mixto' | 'carretera'>('mixto');

  // consumo que predice el modelo base para ese uso (sin calibrar)
  const base = { cruiseKmh: 110, passengers: 1, cargoKg: 20, tempC: 18, climateOn: true, calibration: 1 };
  const modelKmKwh = kind === 'carretera' ? 1 / kwhPerKm(105, base) : 1 / (0.5 * kwhPerKm(95, base) + 0.5 * kwhPerKm(40, base));
  const suggested = Math.max(0.7, Math.min(1.5, modelKmKwh / realKmKwh));

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <div className="sub">Configuración</div>
          <h1>Ajustes</h1>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Car size={16} /> Mi auto
        </div>
        <div className="label">Nombre</div>
        <div className="field">
          <input value={s.nickname} maxLength={24} onChange={(e) => s.set({ nickname: e.target.value })} />
        </div>
        <div className="grid2 mt12">
          <Spec k="Batería" v={`${dec(ORA5.batteryKwh)} kWh`} />
          <Spec k="Potencia" v={`${ORA5.powerHp} HP · ${ORA5.torqueNm} Nm`} />
          <Spec k="Autonomía WLTP" v={`${ORA5.rangeWltpKm} km`} />
          <Spec k="Consumo homologado" v={`${dec(ORA5.wltpKmPerKwh)} km/kWh`} />
          <Spec k="Carga rápida DC" v={`${ORA5.dcMaxKw} kW · ${ORA5.connector}`} />
          <Spec k="Carga AC" v={`${dec(ORA5.acMaxKw)} kW`} />
          <Spec k="0–100 km/h" v={`${dec(ORA5.zeroTo100)} s`} />
          <Spec k="Maleta" v={`${ORA5.trunkL} L`} />
        </div>
        <div className="tiny muted mt8">Ficha técnica GWM Chile (Ora 5 Deluxe). Peso y aerodinámica son estimados.</div>
      </div>

      <div className="card">
        <div className="card-title">
          <Gauge size={16} /> Ajustar a mi consumo real
        </div>
        <div className="small ink2">Mira el consumo promedio en el computador del auto (km/kWh) y lo uso para afinar todas las estimaciones.</div>
        <div className="mt12" />
        <Segmented value={kind} onChange={setKind} options={[{ value: 'mixto', label: 'Uso mixto' }, { value: 'carretera', label: 'Carretera' }]} />
        <div className="mt8" />
        <RangeField label="Mi consumo real" value={realKmKwh} min={3.5} max={9} step={0.1} unit="km/kWh" format={(v) => v.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} onChange={setRealKmKwh} />
        <div className="row between mt8 small">
          <span className="muted">Modelo base: {modelKmKwh.toFixed(1)} km/kWh</span>
          <span className="bold">Factor actual: {s.calibration.toFixed(2)}</span>
        </div>
        <div className="grid2 mt12">
          <button className="btn soft" onClick={() => s.set({ calibration: Math.round(suggested * 100) / 100 })}>
            Aplicar ({suggested.toFixed(2)})
          </button>
          <button className="btn ghost" onClick={() => s.set({ calibration: 1 })}>
            Restablecer
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Volume2 size={16} /> Voz y avisos
        </div>
        <Toggle on={s.voiceOn} onChange={(v) => s.set({ voiceOn: v })} label="Avisos por voz" sub="Habla durante el viaje y la carga" />
        <Toggle on={s.voiceTurns} onChange={(v) => s.set({ voiceTurns: v })} label="Indicaciones de giro" sub='"En 300 metros, gire a la derecha…" (apágalo si usas Google Maps)' />
        <Toggle on={s.voiceChargers} onChange={(v) => s.set({ voiceChargers: v })} label="Avisos de cargadores" sub='"Copec Voltex a 5 kilómetros, 2 de 2 disponibles"' />
        <Toggle on={s.voiceAllChargers} onChange={(v) => s.set({ voiceAllChargers: v })} label="Avisar todos los cargadores rápidos del camino" sub="No solo tus paradas planificadas" />
        <RangeField label="Velocidad de la voz" value={s.voiceRate} min={0.7} max={1.4} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => s.set({ voiceRate: v })} />
        <button
          className="btn soft block mt12"
          onClick={() => {
            unlockSpeech();
            speak('Copec Voltex a 2 kilómetros. 2 de 2 cargadores disponibles. Tu batería estimada es 34 por ciento.', { priority: true, force: true });
          }}
        >
          <Play size={16} /> Probar voz
        </button>
      </div>

      <div className="card">
        <div className="card-title">
          <Wallet size={16} /> Precios
        </div>
        <div className="grid2">
          <div className="stat">
            <div className="k">Carga rápida (DC)</div>
            <div className="v" style={{ fontSize: 17 }}>
              {live.dc ? fmtCLP(live.dc) : '—'}
              <small>/kWh</small>
            </div>
          </div>
          <div className="stat">
            <div className="k">Carga lenta (AC)</div>
            <div className="v" style={{ fontSize: 17 }}>
              {live.ac ? fmtCLP(live.ac) : '—'}
              <small>/kWh</small>
            </div>
          </div>
        </div>
        <div className="tiny muted mt8">
          Automático: cada cargador usa el precio que su operador informa a la SEC, actualizado al abrir la app. Si alguno no informa precio, uso el promedio de arriba.
        </div>
        <div className="mt16" />
        <RangeField label="Luz en casa" value={s.priceHome} min={80} max={400} step={5} format={fmtCLP} unit="/kWh" onChange={(v) => s.set({ priceHome: v })} />
        <div className="mt8" />
        <RangeField label="Bencina 93 (para comparar)" value={s.gasPrice} min={900} max={1800} step={10} format={fmtCLP} unit="/L" onChange={(v) => s.set({ gasPrice: v })} />
        <div className="mt8" />
        <RangeField label="Rendimiento auto a bencina equivalente" value={s.gasKmPerL} min={7} max={20} step={0.5} unit="km/L" onChange={(v) => s.set({ gasKmPerL: v })} />
      </div>

      <SavedRoutesCard />
      <OfflineMapsCard />

      <div className="card">
        <div className="card-title">
          <Smartphone size={16} /> Usar durante el viaje
        </div>
        <div className="small ink2" style={{ display: 'grid', gap: 8 }}>
          <div>
            <b>1.</b> Agrega esta app a la pantalla de inicio (Compartir → “Agregar a inicio” en iPhone, o menú ⋮ → “Instalar app” en Android).
          </div>
          <div>
            <b>2.</b> Para usarla junto a Google Maps: abre la ruta en Google Maps desde la app y luego <b>vuelve a MiAutito</b>. Google Maps te seguirá guiando por voz en segundo plano y MiAutito te avisará de cargadores y batería.
          </div>
          <div>
            <b>3.</b> En Android también puedes usar <b>pantalla dividida</b>: Google Maps arriba y MiAutito abajo.
          </div>
          <div>
            <b>4.</b> MiAutito necesita estar en pantalla para avisarte (el teléfono no la deja hablar si está cerrada). La app mantiene la pantalla encendida durante el viaje.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <Database size={16} /> Datos
        </div>
        <div className="small ink2">
          {stations.length} cargadores públicos · {source === 'live' ? 'en vivo' : 'copia guardada'}
          {updatedAt ? ` · ${new Date(updatedAt).toLocaleString('es-CL')}` : ''}
        </div>
        <div className="tiny muted mt8" style={{ display: 'grid', gap: 4 }}>
          <span>• Cargadores y estado: plataforma de interoperabilidad SEC (cargadorespublicos.cl)</span>
          <span>• Rutas e instrucciones: Valhalla / OpenStreetMap (FOSSGIS)</span>
          <span>• Mapas: OpenFreeMap © OpenStreetMap</span>
          <span>• Búsqueda: Photon (Komoot) · Clima: Open-Meteo</span>
        </div>
      </div>

      <div className="tiny muted center mt16">
        <Info size={12} /> MiAutitoEléctrico v0.1 · Las estimaciones son referenciales: confía siempre en el auto y en las señales de tránsito.
      </div>
    </div>
  );
}

const dec = (n: number) => n.toLocaleString('es-CL');

function SavedRoutesCard() {
  const { routes, remove, save } = useSaved();
  return (
    <div className="card">
      <div className="card-title">
        <Bookmark size={16} /> Rutas frecuentes
      </div>
      {routes.length === 0 && <div className="small muted">Aún no guardas rutas. Calcula un viaje y toca “Guardar como ruta frecuente”.</div>}
      {routes.map((r) => (
        <div key={r.id} className="list-item" style={{ alignItems: 'center' }}>
          <span className="ic-bubble" style={{ width: 38, height: 38 }}>
            {SAVED_ICON[r.kind]}
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="bold ellipsis">{r.name}</div>
            <div className="tiny muted ellipsis">
              {r.origin ? `${r.origin.name} → ` : 'Desde donde estés → '}
              {r.destination.name}
            </div>
            <select
              value={r.routePref}
              onChange={(e) => save({ ...r, routePref: e.target.value as RoutePref })}
              style={{ marginTop: 4, border: 0, background: 'var(--surface-2)', borderRadius: 10, padding: '4px 8px', fontWeight: 700, color: 'var(--primary)', fontSize: 12.5 }}
              aria-label="Tipo de ruta"
            >
              {(Object.keys(ROUTE_PREFS) as RoutePref[]).map((k) => (
                <option key={k} value={k}>
                  {ROUTE_PREFS[k].label}
                </option>
              ))}
            </select>
          </div>
          <button className="icon-btn" style={{ color: 'var(--bad)' }} onClick={() => confirm(`¿Borrar la ruta "${r.name}"?`) && remove(r.id)} aria-label={`Borrar ${r.name}`}>
            <Trash2 size={18} />
          </button>
        </div>
      ))}
    </div>
  );
}

function OfflineMapsCard() {
  const { showToast } = useUi();
  const [usage, setUsage] = useState<{ files: number; usageMb?: number } | null>(null);
  const [prog, setProg] = useState<DownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => offlineUsage().then(setUsage);
  useEffect(() => {
    refresh();
  }, []);
  const santiago = async () => {
    setBusy(true);
    try {
      const res = await downloadTiles(tilesInBox(...SANTIAGO_BOX, 5, 14), setProg);
      showToast(res.failed ? `Mapa de Santiago guardado (faltaron ${res.failed} partes, reintenta luego)` : 'Mapa de Santiago guardado para usar sin internet');
    } catch (e) {
      showToast((e as Error).message || 'No se pudo descargar');
    } finally {
      setBusy(false);
      setProg(null);
      refresh();
    }
  };
  const pct = prog ? Math.round((prog.done / Math.max(1, prog.total)) * 100) : 0;
  return (
    <div className="card">
      <div className="card-title">
        <CloudOff size={16} /> Mapas sin conexión
      </div>
      <div className="small ink2">
        Cada viaje que inicias guarda el mapa de su camino (y las rutas frecuentes también). Así lo ves en túneles y zonas sin internet. La ruta y las indicaciones siempre quedan guardadas.
      </div>
      <div className="small bold mt8">
        {usage ? `${usage.files.toLocaleString('es-CL')} partes de mapa guardadas${usage.usageMb !== undefined ? ` · la app usa ${Math.round(usage.usageMb)} MB` : ''}` : '…'}
      </div>
      {busy ? (
        <>
          <div className="progress mt12">
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="tiny muted mt8">
            <Loader2 size={12} className="spin" /> Descargando… {pct}% {prog && prog.bytes > 0 ? `· ${(prog.bytes / 1e6).toFixed(0)} MB` : ''}
          </div>
        </>
      ) : (
        <div className="grid2 mt12">
          <button className="btn soft" onClick={santiago}>
            <Download size={17} /> Todo Santiago
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              if (!confirm('¿Borrar los mapas descargados? Se vuelven a bajar cuando los uses con internet.')) return;
              await clearOffline();
              refresh();
            }}
          >
            <Trash2 size={17} /> Borrar
          </button>
        </div>
      )}
      <div className="tiny muted mt8">“Todo Santiago” pesa cerca de 45 MB: mejor con Wi-Fi.</div>
    </div>
  );
}

function Spec({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="bold" style={{ fontSize: 14, marginTop: 2 }}>
        {v}
      </div>
    </div>
  );
}
