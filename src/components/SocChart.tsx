import { useEffect, useMemo, useRef, useState } from 'react';
import type { TripPlan } from '../lib/planner';

/**
 * Dos gráficos apilados que comparten el eje de distancia:
 *  - Batería (%) a lo largo del viaje, con las paradas de carga.
 *  - Elevación (m) del camino.
 * (Un eje Y por gráfico — nunca doble eje.)
 */
export default function SocChart({ plan }: { plan: TripPlan }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(340);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, e.contentRect.width)));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const data = useMemo(() => {
    const { route, soc } = plan;
    const n = route.coords.length;
    const total = route.distanceM;
    const samples = 260;
    const pts: { km: number; soc: number; elev: number }[] = [];
    let j = 0;
    const stopIdx = new Set<number>();
    for (const s of plan.stops) {
      let k = 0;
      while (k < n - 1 && route.cum[k] < s.alongM) k++;
      stopIdx.add(k);
    }
    for (let k = 0; k < samples; k++) {
      const d = (k / (samples - 1)) * total;
      while (j < n - 1 && route.cum[j + 1] <= d) {
        j++;
        // conservar los saltos de carga exactos
        if (stopIdx.has(j)) {
          pts.push({ km: route.cum[j] / 1000, soc: plan.stops.find((s) => Math.abs(s.alongM - route.cum[j]) < 1)?.arriveSoc ?? soc[j], elev: route.elev[j] });
          pts.push({ km: route.cum[j] / 1000, soc: soc[j], elev: route.elev[j] });
        }
      }
      pts.push({ km: d / 1000, soc: soc[j], elev: route.elev[j] });
    }
    const elevs = pts.map((p) => p.elev);
    return { pts, totalKm: total / 1000, eMin: Math.min(...elevs), eMax: Math.max(...elevs) };
  }, [plan]);

  const padL = 40;
  const padR = 10;
  const h1 = 150;
  const h2 = 64;
  const gap = 26;
  const H = h1 + gap + h2 + 22;
  const iw = w - padL - padR;
  const x = (km: number) => padL + (km / data.totalKm) * iw;
  const y1 = (s: number) => 8 + (1 - Math.max(0, Math.min(100, s)) / 100) * (h1 - 8);
  const eRange = Math.max(50, data.eMax - data.eMin);
  const y2 = (e: number) => h1 + gap + (1 - (e - data.eMin) / eRange) * h2;

  const socPath = data.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.km).toFixed(1)},${y1(p.soc).toFixed(1)}`).join('');
  const socArea = `${socPath}L${x(data.totalKm)},${y1(0)}L${x(0)},${y1(0)}Z`;
  const elevPath = data.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.km).toFixed(1)},${y2(p.elev).toFixed(1)}`).join('');
  const elevArea = `${elevPath}L${x(data.totalKm)},${h1 + gap + h2}L${x(0)},${h1 + gap + h2}Z`;

  const tickStep = niceStep(data.totalKm / 4);
  const ticks: number[] = [];
  for (let t = 0; t <= data.totalKm + 1e-6; t += tickStep) ticks.push(t);

  const minSoc = plan.input.arrivalMin;
  const hp = hover !== null ? data.pts[hover] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const km = ((e.clientX - r.left - padL) / iw) * data.totalKm;
    if (km < 0 || km > data.totalKm) return setHover(null);
    let best = 0;
    for (let i = 1; i < data.pts.length; i++) if (Math.abs(data.pts[i].km - km) < Math.abs(data.pts[best].km - km)) best = i;
    setHover(best);
  };

  return (
    <div ref={wrap} style={{ position: 'relative', touchAction: 'pan-y' }}>
      <svg width={w} height={H} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} style={{ display: 'block' }}>
        <defs>
          <linearGradient id="socFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1463FF" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#12C6D6" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="socLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#1463FF" />
            <stop offset="100%" stopColor="#12C6D6" />
          </linearGradient>
        </defs>

        {/* Batería */}
        {[0, 50, 100].map((g) => (
          <g key={g}>
            <line x1={padL} x2={w - padR} y1={y1(g)} y2={y1(g)} stroke="var(--line)" strokeWidth={1} />
            <text x={padL - 6} y={y1(g) + 4} textAnchor="end" fontSize="10.5" fill="var(--ink-3)" fontWeight={600}>
              {g}%
            </text>
          </g>
        ))}
        <line x1={padL} x2={w - padR} y1={y1(minSoc)} y2={y1(minSoc)} stroke="#F59E0B" strokeDasharray="4 4" strokeWidth={1.5} />
        <text x={padL + 4} y={y1(minSoc) + 12} textAnchor="start" fontSize="10" fill="#B26B00" fontWeight={700}>
          mínimo {minSoc}%
        </text>
        <path d={socArea} fill="url(#socFill)" />
        <path d={socPath} fill="none" stroke="url(#socLine)" strokeWidth={2.5} strokeLinejoin="round" />
        {plan.stops.map((s, i) => (
          <g key={i} transform={`translate(${x(s.alongM / 1000)},${y1(s.departSoc)})`}>
            <circle r={10} fill="#fff" stroke="#1463FF" strokeWidth={2} />
            <text y={3.8} textAnchor="middle" fontSize="10.5" fontWeight={800} fill="#1463FF">
              {i + 1}
            </text>
          </g>
        ))}

        {/* Elevación */}
        <text x={padL} y={h1 + gap - 7} fontSize="10.5" fontWeight={700} fill="var(--ink-3)">
          Elevación
        </text>
        <path d={elevArea} fill="#E8EEF9" />
        <path d={elevPath} fill="none" stroke="#8B97B3" strokeWidth={1.5} />
        <text x={padL - 6} y={y2(data.eMax) + 4} textAnchor="end" fontSize="10" fill="var(--ink-3)">
          {Math.round(data.eMax)}
        </text>
        <text x={padL - 6} y={y2(data.eMin)} textAnchor="end" fontSize="10" fill="var(--ink-3)">
          {Math.round(data.eMin)}
        </text>

        {/* eje km */}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H - 4} textAnchor={t === 0 ? 'start' : 'middle'} fontSize="10.5" fill="var(--ink-3)" fontWeight={600}>
            {Math.round(t)} km
          </text>
        ))}

        {hp && (
          <g>
            <line x1={x(hp.km)} x2={x(hp.km)} y1={4} y2={h1 + gap + h2} stroke="var(--ink-2)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(hp.km)} cy={y1(hp.soc)} r={5} fill="#1463FF" stroke="#fff" strokeWidth={2} />
            <circle cx={x(hp.km)} cy={y2(hp.elev)} r={4} fill="#8B97B3" stroke="#fff" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: Math.min(Math.max(x(hp.km) - 60, 0), w - 128),
            width: 128,
            background: 'var(--ink)',
            color: '#fff',
            borderRadius: 12,
            padding: '7px 10px',
            fontSize: 12,
            pointerEvents: 'none',
            boxShadow: 'var(--shadow)',
          }}
        >
          <div style={{ fontWeight: 800 }}>km {Math.round(hp.km)}</div>
          <div>Batería {Math.round(hp.soc)}%</div>
          <div style={{ opacity: 0.75 }}>Altura {Math.round(hp.elev)} m</div>
        </div>
      )}
    </div>
  );
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}
