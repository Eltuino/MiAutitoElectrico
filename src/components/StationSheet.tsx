import { Clock, MapPin, Navigation, Plug, Timer, Zap, ParkingSquare } from 'lucide-react';
import { Sheet } from './ui';
import { hoursText, isOpenNow, isOra5Compatible, statusBadge, STATUS_LABEL, summarize, shortName, type Station } from '../lib/chargers';
import { fmtCLP } from '../lib/format';
import { wazeUrl } from '../lib/planner';
import { useUi } from '../store/ui';
import { useSettings } from '../store/settings';

export default function StationSheet({ station, onClose, distanceM }: { station?: Station; onClose: () => void; distanceM?: number }) {
  const openTimer = useUi((u) => u.openTimer);
  const soc = useSettings((s) => s.soc);
  if (!station) return <Sheet open={false} onClose={onClose}>{null}</Sheet>;
  const sum = summarize(station);
  const open = isOpenNow(station);
  const connectors = station.evses.flatMap((e) => e.connectors.map((c, i) => ({ ...c, evse: e.id, key: `${e.id}-${i}` })));
  const compatible = connectors.filter(isOra5Compatible);
  const others = connectors.filter((c) => !isOra5Compatible(c));
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lng}&travelmode=driving`;

  return (
    <Sheet open onClose={onClose}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <span className="ic-bubble" style={{ background: 'var(--grad)', color: '#fff', width: 48, height: 48, borderRadius: 16 }}>
          {sum.hasDc ? <Zap size={22} /> : <Plug size={22} />}
        </span>
        <div className="grow">
          <h3 style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.2 }}>{shortName(station)}</h3>
          <div className="small muted">{station.operator}</div>
        </div>
      </div>

      <div className="row mt12" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className={`badge ${sum.state === 'free' ? 'ok' : sum.state === 'busy' ? 'warn' : sum.state === 'down' ? 'bad' : 'off'}`}>
          <span className="dot" /> {sum.free} de {sum.total} disponibles
        </span>
        {sum.hasDc && <span className="badge blue">hasta {sum.maxDcKw} kW DC</span>}
        {!!sum.maxAcKw && <span className="badge blue">{sum.maxAcKw} kW AC</span>}
        <span className={`badge ${open ? 'ok' : 'bad'}`}>
          <Clock size={11} /> {hoursText(station)}
        </span>
      </div>

      <div className="card soft mt12" style={{ padding: 14 }}>
        <div className="row small">
          <MapPin size={15} className="muted" />
          <span className="grow">
            {station.address}, {station.commune}
            {distanceM !== undefined && <b> · a {(distanceM / 1000).toFixed(1)} km</b>}
          </span>
        </div>
        {station.parking && (
          <div className="row small mt8">
            <ParkingSquare size={15} className="muted" /> {station.parking}
          </div>
        )}
        {(sum.priceDc || sum.priceAc) && (
          <div className="row small mt8">
            <Zap size={15} className="muted" />
            {sum.priceDc && <span>DC {fmtCLP(sum.priceDc)}/kWh</span>}
            {sum.priceAc && <span>AC {fmtCLP(sum.priceAc)}/kWh</span>}
          </div>
        )}
      </div>

      <div className="label mt16">Conectores para tu Ora 5</div>
      {compatible.length === 0 && <div className="small muted">Este lugar no tiene conectores CCS 2 ni Tipo 2.</div>}
      {compatible.map((c) => (
        <div key={c.key} className="list-item">
          <span className="ic-bubble" style={{ width: 38, height: 38 }}>
            {c.type === 'DC' ? <Zap size={17} /> : <Plug size={17} />}
          </span>
          <div className="grow">
            <div className="bold">
              {c.std} · {c.kw} kW
            </div>
            <div className="tiny muted">
              {c.type === 'DC' ? `Tu auto cargará hasta ${Math.min(120, c.kw)} kW` : `Tu auto cargará hasta ${Math.min(6.6, c.kw)} kW`}
              {c.type === 'AC' && !c.cable && ' · lleva tu cable'}
            </div>
          </div>
          <span className={`badge ${statusBadge(c.status)}`}>
            <span className="dot" />
            {STATUS_LABEL[c.status]}
          </span>
        </div>
      ))}
      {others.length > 0 && <div className="tiny muted mt8">Además: {[...new Set(others.map((c) => c.std))].join(', ')} (no compatibles)</div>}

      <div className="grid2 mt16">
        <a className="btn ghost" href={gmaps} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
          <Navigation size={17} /> Google Maps
        </a>
        <a className="btn ghost" href={wazeUrl([station.lng, station.lat])} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
          <Navigation size={17} /> Waze
        </a>
      </div>
      <button
        className="btn primary block mt12"
        onClick={() => {
          const dc = sum.hasDc;
          openTimer({
            startSoc: soc,
            targetSoc: 80,
            kw: dc ? sum.maxDcKw : sum.maxAcKw || 7,
            type: dc ? 'DC' : 'AC',
            price: dc ? sum.priceDc : sum.priceAc,
            stationName: shortName(station),
          });
          onClose();
        }}
      >
        <Timer size={18} /> Cronometrar carga aquí
      </button>
      <div className="tiny muted center mt8">Estado en vivo informado por el operador a la SEC.</div>
    </Sheet>
  );
}
