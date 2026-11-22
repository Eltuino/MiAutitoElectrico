import { useEffect, type ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode; sub?: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} role="radio" aria-checked={o.value === value}>
          <span>{o.label}</span>
          {o.sub && <span className="seg-sub">{o.sub}</span>}
        </button>
      ))}
    </div>
  );
}

export function RangeField({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
  format,
  hint,
}: {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  hint?: ReactNode;
}) {
  const p = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="range-head">
        <span>{label}</span>
        <span className="val">
          {format ? format(value) : value}
          {unit && <span className="muted small"> {unit}</span>}
        </span>
      </div>
      <input
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ['--p' as string]: `${p}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={typeof label === 'string' ? label : undefined}
      />
      {hint && <div className="tiny muted">{hint}</div>}
    </div>
  );
}

export function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="stepper">
      <button onClick={() => onChange(Math.max(min, value - 1))} aria-label="Menos">
        <Minus size={16} strokeWidth={3} />
      </button>
      <span className="v">{value}</span>
      <button onClick={() => onChange(Math.min(max, value + 1))} aria-label="Más">
        <Plus size={16} strokeWidth={3} />
      </button>
    </div>
  );
}

export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog">
        <div className="sheet-grip" />
        {children}
      </div>
    </>
  );
}

export function Toggle({ on, onChange, label, sub }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; sub?: ReactNode }) {
  return (
    <button className="row between" style={{ width: '100%', padding: '10px 2px', textAlign: 'left' }} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="grow">
        <span className="bold" style={{ display: 'block', fontSize: 14.5 }}>
          {label}
        </span>
        {sub && <span className="small muted">{sub}</span>}
      </span>
      <span
        style={{
          width: 50,
          height: 30,
          borderRadius: 99,
          background: on ? 'var(--primary)' : 'var(--surface-3)',
          position: 'relative',
          transition: 'background .2s',
          flex: 'none',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 3,
            left: on ? 23 : 3,
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 2px 6px rgba(0,0,0,.18)',
            transition: 'left .2s',
          }}
        />
      </span>
    </button>
  );
}

/** Color de la batería por nivel (estado) */
export function socColor(soc: number) {
  if (soc < 10) return '#F04438';
  if (soc < 20) return '#F59E0B';
  if (soc < 45) return '#12C6D6';
  return '#1463FF';
}
