import { useId } from 'react';
import { socColor } from './ui';

/** Anillo de batería con degradado azul → turquesa */
export default function BatteryRing({
  soc,
  size = 140,
  stroke = 14,
  label,
  sub,
  charging,
  target,
}: {
  soc: number;
  size?: number;
  stroke?: number;
  label?: React.ReactNode;
  sub?: React.ReactNode;
  charging?: boolean;
  target?: number;
}) {
  const id = useId().replace(/:/g, '');
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, soc));
  const low = pct < 20;
  const targetAngle = target !== undefined ? (target / 100) * 360 - 90 : null;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={low ? socColor(pct) : '#1463FF'} />
            <stop offset="100%" stopColor={low ? socColor(pct) : '#12C6D6'} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#g${id})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray .8s cubic-bezier(.2,.8,.2,1)' }}
          className={charging ? 'pulse' : undefined}
        />
        {targetAngle !== null && (
          <circle
            cx={size / 2 + r * Math.cos((targetAngle * Math.PI) / 180)}
            cy={size / 2 + r * Math.sin((targetAngle * Math.PI) / 180)}
            r={stroke / 2 - 2}
            fill="#fff"
            stroke="var(--primary)"
            strokeWidth={3}
          />
        )}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        <div>
          <div style={{ fontSize: size * 0.24, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1 }}>
            {label ?? `${Math.round(pct)}%`}
          </div>
          {sub && <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink-3)', marginTop: 4 }}>{sub}</div>}
        </div>
      </div>
    </div>
  );
}
