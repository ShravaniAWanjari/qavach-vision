import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Scene, SCENE_H, SCENE_W } from '../scenes/Scene';
import { demoPhoto } from '../scenes/photos';
import { ZONE_COLORS } from '../scenes/zones';
import type { Alert, AlertState, Camera, Channel, Priority, Zone } from '../data/types';
import { apiUrl, streamUrl, stillUrl } from '../lib/backend';
import { hms } from '../lib/time';
import { useService } from '../state/bridge';
import { Icon, type IconName } from './Icon';
import './ui.css';

export const PRIORITY_NAME: Record<Priority, string> = { P1: 'Critical', P2: 'High', P3: 'Medium', P4: 'Low' };

export function PriorityBadge({ p, short }: { p: Priority; short?: boolean }) {
  return (
    <span className={`prio prio--${p}`}>
      {p === 'P1' && <Icon name="warning" size={13} stroke={2.2} />}
      {p}
      {!short && ` ${PRIORITY_NAME[p]}`}
    </span>
  );
}

const STATE: Record<AlertState, [string, string]> = {
  new: ['New', 'chip--danger'],
  escalated: ['Escalated', 'chip--rising'],
  acknowledged: ['Acknowledged', 'chip--warn'],
  resolved: ['Resolved', 'chip--good'],
  'false-alarm': ['False alarm', ''],
};
export function StateChip({ state }: { state: AlertState }) {
  const [label, cls] = STATE[state];
  return <span className={`chip ${cls}`}>{label}</span>;
}

export const CHANNEL: Record<Channel, { label: string; icon: IconName }> = {
  wall: { label: 'Video wall', icon: 'wall' },
  push: { label: 'Mobile push', icon: 'mobile' },
  sms: { label: 'SMS', icon: 'sms' },
  whatsapp: { label: 'WhatsApp', icon: 'chat' },
  email: { label: 'Email', icon: 'mail' },
  call: { label: 'Phone call', icon: 'phone' },
};

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track" />
      {label && <span>{label}</span>}
    </label>
  );
}

/**
 * Qavach's dropdown (its "basic auto complete"): a 56px field with the label inside, a solid ▼ at the right, and a
 * list attached flush under the box. You can type in the box to narrow the list. Opens on click; closes on a click
 * outside, Escape, or when the page scrolls under it. The list floats over the page (fixed, measured from the box)
 * so cards, dialogs and scrolling panels never clip it, and opens upwards when there is no room below.
 */
function useDropdown() {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ style: CSSProperties; up: boolean }>({ style: {}, up: false });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const r = ref.current!.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const up = below < 240 && r.top > below;
    setPlace({ up, style: { left: r.left, width: r.width, ...(up ? { bottom: window.innerHeight - r.top - 1 } : { top: r.bottom - 1 }) } });
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    // A resize comes from the window itself, which is not inside anything.
    const moved = (e: Event) => !(e.target instanceof Node && ref.current?.contains(e.target)) && setOpen(false);
    document.addEventListener('mousedown', away);
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
    };
  }, [open]);
  return { open, setOpen, ref, place };
}

/** The typing, keyboard and list state both dropdowns share. */
function useSearchList<O extends { label: string }>(options: O[], open: boolean, startAt: number) {
  const [query, setQuery] = useState('');
  const [mark, setMark] = useState(0);
  const shown = query.trim() ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase())) : options;
  useEffect(() => {
    if (!open) setQuery('');
    else setMark(Math.max(0, startAt));
  }, [open]);
  useEffect(() => setMark(0), [query]);
  return { query, setQuery, mark, setMark, shown };
}

type ChoiceOption<T> = { value: T; label: string; group?: string };

function Arrow() {
  return <span className="msel__arrow" aria-hidden="true" />;
}

/**
 * Pick one option. `clearTo` adds Qavach's × for filters: it puts the field back to that value (usually "all").
 * `small` is the 40px box for toolbars and tight panels; it has no label inside, so pass the label for screen readers.
 */
export function Choice<T extends string | number>({ id, label, options, value, onChange, disabled, small, className, prefix, clearTo }: { id?: string; label: string; options: ChoiceOption<T>[]; value: T; onChange: (v: T) => void; disabled?: boolean; small?: boolean; className?: string; prefix?: string; clearTo?: T }) {
  const { open, setOpen, ref, place } = useDropdown();
  const input = useRef<HTMLInputElement>(null);
  const current = options.find((o) => o.value === value);
  const { query, setQuery, mark, setMark, shown } = useSearchList(options, open, options.indexOf(current!));
  const off = () => disabled || !!input.current?.matches(':disabled');
  const pick = (o: ChoiceOption<T>) => {
    onChange(o.value);
    setOpen(false);
  };
  const keys = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      setMark((m) => (e.key === 'ArrowDown' ? Math.min(shown.length - 1, m + 1) : Math.max(0, m - 1)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && shown[mark]) pick(shown[mark]);
      else setOpen(true);
    } else if (e.key === 'Escape') setOpen(false);
  };
  return (
    <div className={`msel${small ? ' msel--sm' : ''}${open ? ' is-open' : ''}${open && place.up ? ' is-up' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`} ref={ref}>
      <div
        className="msel__box"
        onClick={() => {
          if (off()) return;
          setOpen((v) => !v);
          input.current?.focus();
        }}
      >
        {!small && (
          <label className="msel__label" htmlFor={id}>
            {label}
          </label>
        )}
        <div className="msel__row">
          {!query && (
            <span className="msel__value" title={current?.label}>
              {prefix && <span className="msel__prefix">{prefix} </span>}
              {current?.label ?? 'Select'}
            </span>
          )}
          <input
            ref={input}
            id={id}
            className="msel__search"
            role="combobox"
            aria-expanded={open}
            aria-label={small ? label : undefined}
            autoComplete="off"
            disabled={disabled}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onKeyDown={keys}
          />
        </div>
        {clearTo !== undefined && value !== clearTo && (
          <button
            type="button"
            className="msel__clear"
            aria-label={`Clear ${label}`}
            title="Clear"
            onClick={(e) => {
              e.stopPropagation();
              onChange(clearTo);
              setOpen(false);
            }}
          >
            ×
          </button>
        )}
        <Arrow />
      </div>
      {open && (
        <div className={`msel__menu${place.up ? ' is-up' : ''}`} style={place.style} role="listbox" aria-label={label}>
          <div className="msel__items">
            {shown.length === 0 && <div className="msel__none">No items found</div>}
            {shown.map((o, i) => (
              <div key={String(o.value)} style={{ display: 'contents' }}>
                {o.group && o.group !== shown[i - 1]?.group && <div className="msel__group">{o.group}</div>}
                <div
                  role="option"
                  aria-selected={o.value === value}
                  className={`msel__opt${o.value === value ? ' is-on' : ''}${i === mark ? ' is-mark' : ''}`}
                  onMouseEnter={() => setMark(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                >
                  {o.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export type CascadeField<K extends string, D extends string> = { key: K; label: string; options: { value: D; label: string }[] };

/**
 * A sort picker with two levels: the main list says what to sort by; clicking one opens a side list with its
 * directions (A to Z, Z to A, ...). Picking a direction applies it and closes both. Styled as Qavach's dropdown.
 */
export function CascadeSelect<K extends string, D extends string>({ label, prefix, fields, value, onChange, className }: { label: string; prefix: string; fields: CascadeField<K, D>[]; value: { key: K; dir: D }; onChange: (v: { key: K; dir: D }) => void; className?: string }) {
  const { open, setOpen, ref, place } = useDropdown();
  const [side, setSide] = useState<{ key: K; style: CSSProperties } | null>(null);
  useEffect(() => {
    if (!open) setSide(null);
  }, [open]);
  const current = fields.find((f) => f.key === value.key);
  const text = `${current?.label ?? ''} · ${current?.options.find((o) => o.value === value.dir)?.label ?? ''}`;
  const openSide = (f: CascadeField<K, D>, el: HTMLElement) => {
    if (side?.key === f.key) return setSide(null);
    const menu = el.closest('.msel__menu')!.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    const room = window.innerWidth - menu.right - 12;
    setSide({ key: f.key, style: { top: row.top, width: 190, ...(room >= 194 ? { left: menu.right + 2 } : { right: window.innerWidth - menu.left + 2 }) } });
  };
  const sideField = fields.find((f) => f.key === side?.key);
  return (
    <div className={`msel msel--sm${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`} ref={ref}>
      <button type="button" className="msel__box" aria-haspopup="menu" aria-expanded={open} aria-label={`${label}: ${text}`} onClick={() => setOpen((v) => !v)} title={text}>
        <span className="msel__row">
          <span className="msel__value">
            <span className="msel__prefix">{prefix} </span>
            {text}
          </span>
        </span>
        <Arrow />
      </button>
      {open && (
        <>
          <div className={`msel__menu${place.up ? ' is-up' : ''}`} style={place.style} role="menu" aria-label={label}>
            <div className="msel__items">
              {fields.map((f) => (
                <button key={f.key} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={side?.key === f.key} className={`msel__opt msel__opt--main${f.key === value.key ? ' is-on' : ''}${side?.key === f.key ? ' is-mark' : ''}`} onClick={(e) => openSide(f, e.currentTarget)}>
                  <span>{f.label}</span>
                  <Icon name="chevron-right" size={16} stroke={2.2} />
                </button>
              ))}
            </div>
          </div>
          {side && sideField && (
            <div className="msel__menu msel__side" style={side.style} role="menu" aria-label={`${sideField.label} order`}>
              <div className="msel__items">
                {sideField.options.map((o) => {
                  const on = value.key === sideField.key && value.dir === o.value;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={on}
                      className={`msel__opt${on ? ' is-on' : ''}`}
                      onClick={() => {
                        onChange({ key: sideField.key, dir: o.value });
                        setOpen(false);
                      }}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Pick any number of options from a checklist, as Qavach's multiple dropdown: the box shows the first pick and how
 * many more ("Accident, 1 More..."). `clearable` adds the × that empties it.
 */
export function MultiSelect<T extends string>({ id, label, options, value, onChange, placeholder = 'Select', disabled, clearable }: { id: string; label: string; options: { value: T; label: string; icon?: IconName }[]; value: T[]; onChange: (v: T[]) => void; placeholder?: string; disabled?: boolean; clearable?: boolean }) {
  const { open, setOpen, ref, place } = useDropdown();
  const input = useRef<HTMLInputElement>(null);
  const { query, setQuery, mark, setMark, shown } = useSearchList(options, open, 0);
  const chosen = options.filter((o) => value.includes(o.value));
  const text = chosen.length === 0 ? placeholder : chosen.length === 1 ? chosen[0].label : `${chosen[0].label}, ${chosen.length - 1} More...`;
  const off = () => disabled || !!input.current?.matches(':disabled');
  // Keep picks in the options' order, whatever order they were ticked in.
  const toggle = (v: T) => {
    const next = value.includes(v) ? value.filter((x) => x !== v) : [...value, v];
    onChange(options.map((o) => o.value).filter((x) => next.includes(x)));
  };
  const keys = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      setMark((m) => (e.key === 'ArrowDown' ? Math.min(shown.length - 1, m + 1) : Math.max(0, m - 1)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && shown[mark]) toggle(shown[mark].value);
      else setOpen(true);
    } else if (e.key === 'Escape') setOpen(false);
  };
  return (
    <div className={`msel${open ? ' is-open' : ''}${open && place.up ? ' is-up' : ''}${disabled ? ' is-disabled' : ''}`} ref={ref}>
      <div
        className="msel__box"
        title={chosen.map((o) => o.label).join(', ')}
        onClick={() => {
          if (off()) return;
          setOpen((v) => !v);
          input.current?.focus();
        }}
      >
        <label className="msel__label" htmlFor={id}>
          {label}
        </label>
        <div className="msel__row">
          {!query && <span className={`msel__value${chosen.length ? '' : ' is-empty'}`}>{text}</span>}
          <input ref={input} id={id} className="msel__search" role="combobox" aria-expanded={open} autoComplete="off" disabled={disabled} value={query} onChange={(e) => (setQuery(e.target.value), setOpen(true))} onKeyDown={keys} />
        </div>
        {clearable && chosen.length > 0 && (
          <button
            type="button"
            className="msel__clear"
            aria-label={`Clear ${label}`}
            title="Clear all"
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
              setOpen(false);
            }}
          >
            ×
          </button>
        )}
        <Arrow />
      </div>
      {open && (
        <div className={`msel__menu${place.up ? ' is-up' : ''}`} style={place.style} role="listbox" aria-multiselectable="true" aria-label={label}>
          <div className="msel__items">
            {shown.length === 0 && <div className="msel__none">No items found</div>}
            {shown.map((o, i) => (
              <label key={o.value} className={`msel__opt msel__opt--check${value.includes(o.value) ? ' is-on' : ''}${i === mark ? ' is-mark' : ''}`} onMouseEnter={() => setMark(i)} onMouseDown={(e) => e.preventDefault()}>
                <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A whole number typed in, or stepped with − and +, inside the same 56px labelled box as the dropdowns. */
export function NumberField({ id, label, value, onChange, min, max, unit, disabled }: { id: string; label: string; value: number; onChange: (v: number) => void; min: number; max: number; unit?: (v: number) => string; disabled?: boolean }) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const commit = (t: string) => {
    const n = Number(t);
    if (t.trim() !== '' && Number.isFinite(n)) onChange(clamp(n));
    setEditing(false);
  };
  return (
    <div className={`nfield${disabled ? ' is-disabled' : ''}`}>
      <label htmlFor={id} className="nfield__label">
        {label}
      </label>
      <div className="nfield__row">
        <input
          id={id}
          className="nfield__input"
          inputMode="numeric"
          disabled={disabled}
          value={editing ? text : String(value)}
          size={Math.max(1, (editing ? text : String(value)).length)}
          onFocus={() => {
            setText(String(value));
            setEditing(true);
          }}
          onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const n = clamp((Number(e.currentTarget.value) || value) + (e.key === 'ArrowUp' ? 1 : -1));
              setText(String(n));
              onChange(n);
            }
          }}
        />
        {unit && <span className="nfield__unit">{unit(editing ? Number(text) || 0 : value)}</span>}
      </div>
      <div className="nfield__step">
        <button type="button" aria-label={`Decrease ${label}`} disabled={disabled || value <= min} onClick={() => onChange(clamp(value - 1))}>
          −
        </button>
        <button type="button" aria-label={`Increase ${label}`} disabled={disabled || value >= max} onClick={() => onChange(clamp(value + 1))}>
          +
        </button>
      </div>
    </div>
  );
}

export function Seg<T extends string | number>({ options, value, onChange, small, label }: { options: { value: T; label: ReactNode; title?: string }[]; value: T; onChange: (v: T) => void; small?: boolean; label: string }) {
  return (
    <div className={`seg${small ? ' seg--sm' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

export function Modal({ title, onClose, children, footer, wide, icon }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; icon?: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal__head">
          {icon}
          <h2>{title}</h2>
          <span className="spacer" />
          {/* Qavach's pop-ups close from their Cancel button; only one without buttons gets a close cross. */}
          {!footer && (
            <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="Close">
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * A yes/no question inside the page. The browser's own confirm() is blocked in embedded browsers and some
 * kiosk setups, which made every delete button do nothing. `ask(...)` opens it, `dialog` goes in the JSX.
 */
export function useConfirm() {
  const [q, setQ] = useState<{ title: string; message: string; action: string; danger: boolean; onYes: () => void } | null>(null);
  const ask = (o: { title: string; message: string; action?: string; danger?: boolean }, onYes: () => void) =>
    setQ({ action: 'Delete', danger: true, ...o, onYes });
  const close = () => setQ(null);
  const dialog = q && (
    <Modal
      title={q.title}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${q.danger ? 'btn--danger' : 'btn--primary'}`}
            autoFocus
            onClick={() => {
              close();
              q.onYes();
            }}
          >
            {q.action}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>{q.message}</p>
    </Modal>
  );
  return { ask, dialog };
}

export function Drawer({ title, onClose, children, footer, wide, sub }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className={`drawer${wide ? ' drawer--wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal__head">
          <div className="stack" style={{ gap: 2 }}>
            <h2>{title}</h2>
            {sub && <span className="meta">{sub}</span>}
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal__body" style={{ flex: 1 }}>
          {children}
        </div>
        {footer && <div className="modal__foot">{footer}</div>}
      </aside>
    </>
  );
}

// Overlays share the picture's space and its "slice" crop, so zones and boxes stay on the right spot whatever shape
// the tile is. The drawn scenes are 640 × 360; a real camera uses its own width to height ratio.
const sizeFor = (aspect: number) => ({ vw: SCENE_H * aspect, W: (SCENE_H * aspect) / 100, H: SCENE_H / 100 });

export function ZoneOverlay({ zones, highlight, box, aspect = SCENE_W / SCENE_H }: { zones: Zone[]; highlight?: string[]; box?: Alert; aspect?: number }) {
  const { vw, W, H } = sizeFor(aspect);
  const pts = (z: Zone) => z.points.map((p) => `${p[0] * W},${p[1] * H}`).join(' ');
  return (
    <svg className="camview__zones" viewBox={`0 0 ${vw} ${SCENE_H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {zones.map((z) => {
        const c = ZONE_COLORS[z.purpose];
        const on = !highlight || highlight.includes(z.id);
        return z.kind === 'line' ? (
          <polyline key={z.id} points={pts(z)} fill="none" stroke={c} strokeWidth={on ? 3 : 1.5} strokeDasharray="8 5" vectorEffect="non-scaling-stroke" opacity={on ? 1 : 0.45} />
        ) : (
          <polygon key={z.id} points={pts(z)} fill={c} fillOpacity={on ? 0.22 : 0.08} stroke={c} strokeWidth={on ? 2 : 1} vectorEffect="non-scaling-stroke" opacity={on ? 1 : 0.55} />
        );
      })}
      {box && <DetectionBox alert={box} W={W} H={H} />}
    </svg>
  );
}

// Detection boxes on the picture: [box line, label fill, label text], from the design system's swatches. Lines stay
// light enough to see on video; the label matches the level's chip.
const BOX_COLOR: Record<Priority, [string, string, string]> = { P1: ['#E5456D', '#E5456D', '#fff'], P2: ['#D7DEE0', '#0C323D', '#fff'], P3: ['#A6B8BD', '#567C87', '#fff'], P4: ['#A6B8BD', '#A6B8BD', '#0C323D'] };

// A person on a wide camera is often 10 to 20 px tall, so a box drawn exactly on them is smaller than its own
// outline and reads as a blob. The box is grown around the person to a minimum size (in the overlay's 360-high units,
// about 4 % of the picture's height for the smallest) so it is always a clear rectangle with the person inside.
const BOX_PAD = 5;
const BOX_MIN_W = 20;
const BOX_MIN_H = 30;

function DetectionBox({ alert, W, H }: { alert: Alert; W: number; H: number }) {
  const [x, y, w, h] = alert.box;
  const [stroke, fill, ink] = BOX_COLOR[alert.priority];
  const vw = 100 * W;
  const vh = 100 * H;
  const bw = Math.max(w * W + 2 * BOX_PAD, BOX_MIN_W);
  const bh = Math.max(h * H + 2 * BOX_PAD, BOX_MIN_H);
  const bx = Math.min(vw - bw, Math.max(0, (x + w / 2) * W - bw / 2));
  const by = Math.min(vh - bh, Math.max(0, (y + h / 2) * H - bh / 2));
  const label = `${Math.round(alert.confidence * 100)}%`;
  const lw = label.length * 6 + 8;
  const lh = 13;
  const ly = by - lh >= 0 ? by - lh : by + bh; // above the box, or below it when the box touches the top edge
  const lx = Math.min(vw - lw, bx);
  return (
    <g>
      <rect x={bx} y={by} width={bw} height={bh} fill="none" stroke="#000" strokeOpacity={0.45} strokeWidth={3.5} vectorEffect="non-scaling-stroke" />
      <rect x={bx} y={by} width={bw} height={bh} fill="none" stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <rect x={lx} y={ly} width={lw} height={lh} fill={fill} />
      <text x={lx + 4} y={ly + lh - 3.5} fill={ink} fontSize={9} fontWeight={600} fontFamily="Exo 2, sans-serif">
        {label}
      </text>
    </g>
  );
}

export function ZoneLabels({ zones, highlight }: { zones: Zone[]; highlight?: string[] }) {
  return (
    <>
      {zones
        .filter((z) => !highlight || highlight.includes(z.id))
        .map((z) => {
          const n = z.points.length;
          const x = z.points.reduce((s, p) => s + p[0], 0) / n;
          const y = Math.min(...z.points.map((p) => p[1]));
          return (
            <span key={z.id} className="camview__zone-label" style={{ left: `${Math.min(86, Math.max(2, x))}%`, top: `${Math.max(2, y - 7)}%`, borderColor: ZONE_COLORS[z.purpose] }}>
              {z.name}
            </span>
          );
        })}
    </>
  );
}

/** How often a still tile of a real camera fetches a fresh frame. */
const STILL_REFRESH_MS = 4000;

/** The picture of a real camera:
 *  - live (not `still`): the live preview from the detection service, running like the camera itself;
 *  - `still`: the latest frame, refreshed every few seconds, so a thumbnail follows the camera;
 *  - `frozen`: the frame taken when the camera was connected, for drawing zones on;
 *  - an alert's snapshot, when one is given (the moment it was raised).
 *  Every one of these is served by the detection service, so when it is not running nothing can load: say so,
 *  and tell the parent so it does not draw an alert's box over an empty frame. */
function RealPicture({ cam, still, frozen, snapshot, serviceUp, onMissing }: { cam: Camera; still?: boolean; frozen?: boolean; snapshot?: string; serviceUp: boolean; onMissing: (missing: boolean) => void }) {
  const [broken, setBroken] = useState(false); // the live preview would not load
  const [bump, setBump] = useState(0);
  const [badBump, setBadBump] = useState(-1); // the refresh that found no picture yet
  const [failed, setFailed] = useState<string | null>(null); // the last address that could not be loaded at all
  const refreshing = !!still && !frozen && !snapshot && serviceUp;
  useEffect(() => {
    setBroken(false);
    setFailed(null);
  }, [cam.id, serviceUp]);
  useEffect(() => {
    if (!refreshing) return;
    const t = window.setInterval(() => setBump((n) => n + 1), STILL_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refreshing]);
  const fallback = stillUrl(cam);
  const latest = refreshing && badBump !== bump ? `${apiUrl(`/api/cameras/${encodeURIComponent(cam.id)}/frame.jpg`)}?t=${bump}` : undefined;
  const src = snapshot ? apiUrl(snapshot) : !still && !frozen && serviceUp && !broken ? streamUrl(cam) : (latest ?? fallback);
  const missing = !src || failed === src;
  useEffect(() => onMissing(missing), [missing, onMissing]);
  if (missing)
    return (
      <div className="camview__nopic">
        <Icon name="camera" size={22} />
        <span>{serviceUp ? 'No picture from this camera' : 'No picture: the detection service is not running'}</span>
        {!serviceUp && <small>Start it with backend/run.sh</small>}
      </div>
    );
  const onError = () => {
    if (src === fallback || src === (snapshot ? apiUrl(snapshot) : '')) setFailed(src);
    else if (src === latest) setBadBump(bump);
    else setBroken(true);
  };
  return <img className="camview__img" src={src} alt="" onError={onError} draggable={false} />;
}

/** A camera picture with its caption, and optionally zones and an alert's detection box. */
export function CameraView({
  cam,
  still,
  frozen,
  alert,
  zones,
  highlightZones,
  showZoneLabels,
  caption = true,
  now,
  className,
  children,
}: {
  cam: Camera;
  still?: boolean;
  /** Real cameras: keep the frame taken at connection (zone drawing) instead of following the camera. */
  frozen?: boolean;
  alert?: Alert;
  zones?: Zone[];
  highlightZones?: string[];
  showZoneLabels?: boolean;
  caption?: boolean;
  now?: number;
  className?: string;
  children?: ReactNode;
}) {
  const service = useService();
  const [noPicture, setNoPicture] = useState(false);
  // An alert's snapshot shows only where the picture is a still (or the service is down). In a live view the
  // picture is the camera now, and the service draws the people it sees on it, so an old box would be wrong.
  const liveReal = !!cam.source && !still && !frozen && service.online;
  const snapshot = cam.source && !liveReal ? alert?.snapshot : undefined;
  const aspect = cam.source?.width && cam.source?.height ? cam.source.width / cam.source.height : undefined;
  // A demo photo is a real picture, so the zones and detection boxes drawn for the sample scenes would not fit it.
  const photo = demoPhoto(cam);
  const subjType = alert ? (alert.title.toLowerCase().includes('smoke') ? 'smoke' : alert.title.toLowerCase().includes('truck') || alert.title.toLowerCase().includes('vehicle') ? 'vehicle' : 'person') : undefined;
  return (
    <div className={`camview${className ? ` ${className}` : ''}`} style={aspect ? ({ '--ar': aspect } as CSSProperties) : undefined}>
      {cam.source ? (
        <RealPicture cam={cam} still={still} frozen={frozen} snapshot={snapshot} serviceUp={service.online} onMissing={setNoPicture} />
      ) : photo ? (
        <img className="camview__img" src={photo.src} style={photo.style} alt="" draggable={false} />
      ) : (
        <Scene
          kind={cam.scene}
          variant={cam.variant}
          still={still}
          offline={cam.status === 'offline'}
          title={`${cam.id} ${cam.name}`}
          subject={alert && subjType ? { box: alert.box, type: subjType, noPpe: /helmet|vest|life jacket|ppe/i.test(alert.title + alert.detail) } : undefined}
        />
      )}
      {!photo && ((zones && zones.length > 0) || alert) && <ZoneOverlay zones={zones ?? []} highlight={highlightZones} box={liveReal || (cam.source && noPicture) ? undefined : alert} aspect={aspect} />}
      {!photo && zones && showZoneLabels && <ZoneLabels zones={zones} highlight={highlightZones} />}
      {caption && (
        <div className="camview__caption">
          <span className="camview__id">{cam.id}</span>
          <span className="ellipsis">{cam.name}</span>
          <span className="spacer" />
          {cam.status !== 'offline' && <span className="camview__rec" aria-label="Live" />}
          {now !== undefined && <span className="camview__time">{hms(now)}</span>}
        </div>
      )}
      {cam.status === 'degraded' && <span className="camview__degraded">Degraded · low light</span>}
      {children}
    </div>
  );
}

export function Empty({ icon = 'info', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <strong style={{ color: 'var(--q-ink)' }}>{title}</strong>
      {children}
    </div>
  );
}

export function QaiLabel({ children = 'QAI draft' }: { children?: ReactNode }) {
  return (
    <span className="qai__label">
      <Icon name="spark" size={15} />
      {children}
    </span>
  );
}
