import { useState } from 'react';
import { Car, Info, Volume2, Wallet, Gauge, Smartphone, Database, Play } from 'lucide-react';
import { RangeField, Toggle, Segmented } from '../components/ui';
import { ORA5 } from '../lib/car';
import { useSettings } from '../store/settings';
import { speak, unlockSpeech } from '../lib/voice';
import { fmtCLP } from '../lib/format';
import { useChargers } from '../lib/chargers';
import { kwhPerKm } from '../lib/energy';

export default function Settings() {
  const s = useSettings();
  const { stations, source, updatedAt } = useChargers();
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
        <RangeField label="Carga rápida DC (si no está informada)" value={s.priceDc} min={200} max={700} step={10} format={fmtCLP} unit="/kWh" onChange={(v) => s.set({ priceDc: v })} />
        <div className="mt8" />
        <RangeField label="Carga AC pública" value={s.priceAc} min={0} max={600} step={10} format={fmtCLP} unit="/kWh" onChange={(v) => s.set({ priceAc: v })} />
        <div className="mt8" />
        <RangeField label="Luz en casa" value={s.priceHome} min={80} max={400} step={5} format={fmtCLP} unit="/kWh" onChange={(v) => s.set({ priceHome: v })} />
        <div className="mt8" />
        <RangeField label="Bencina 93 (para comparar)" value={s.gasPrice} min={900} max={1800} step={10} format={fmtCLP} unit="/L" onChange={(v) => s.set({ gasPrice: v })} />
        <div className="mt8" />
        <RangeField label="Rendimiento auto a bencina equivalente" value={s.gasKmPerL} min={7} max={20} step={0.5} unit="km/L" onChange={(v) => s.set({ gasKmPerL: v })} />
      </div>

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
