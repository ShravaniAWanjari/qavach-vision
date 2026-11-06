import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
export const fmtShort = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Two month calendars side by side. Click a first day, then a last day: the range is chosen and the calendar closes.
 *  Clicking the same day twice picks that one day. Dates are the start of each day. */
export function DateRangePicker({ from, to, today, onChange, onClose }: { from: number; to: number; today: number; onChange: (from: number, to: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [base, setBase] = useState(() => {
    const d = new Date(from);
    return d.getFullYear() * 12 + d.getMonth();
  });
  const [menu, setMenu] = useState<{ side: 0 | 1; kind: 'month' | 'year' } | null>(null);
  const thisYear = new Date(today).getFullYear();

  useEffect(() => {
    const away = (e: MouseEvent) => {
      // Clicks on the period pills and the Date Range field belong to them; they open and close the calendar themselves.
      const keep = ref.current?.closest('.ovperiod');
      if (!ref.current?.contains(e.target as Node) && !keep?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  const pick = (day: number) => {
    if (anchor === null) {
      setAnchor(day);
      return;
    }
    onChange(Math.min(anchor, day), Math.max(anchor, day));
    onClose();
  };
  const lo = anchor !== null ? Math.min(anchor, hover ?? anchor) : from;
  const hi = anchor !== null ? Math.max(anchor, hover ?? anchor) : to;

  const month = (offset: 0 | 1) => {
    const index = base + offset;
    const y = Math.floor(index / 12);
    const m = index % 12;
    const lead = new Date(y, m, 1).getDay(); // Sunday first
    const count = new Date(y, m + 1, 0).getDate();
    const cells = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => new Date(y, m, i + 1).getTime())] as (number | null)[];
    const open = (kind: 'month' | 'year') => setMenu(menu?.side === offset && menu.kind === kind ? null : { side: offset, kind });
    return (
      <div className="drcal">
        <div className="drcal__head">
          {offset === 0 ? (
            <button type="button" className="drcal__arrow" aria-label="Previous month" onClick={() => setBase(base - 1)}>
              <Icon name="chevron-left" size={22} stroke={2.4} />
            </button>
          ) : (
            <span className="drcal__arrow" />
          )}
          <div className="drcal__pickers">
            <div className="drcal__picker">
              <button type="button" onClick={() => open('month')} aria-haspopup="listbox" aria-expanded={menu?.side === offset && menu.kind === 'month'}>
                {MONTHS[m]}
                <i />
              </button>
              {menu?.side === offset && menu.kind === 'month' && (
                <ul className="drcal__menu" role="listbox">
                  {MONTHS.map((name, i) => (
                    <li key={name}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === m}
                        onClick={() => {
                          setBase(y * 12 + i - offset);
                          setMenu(null);
                        }}
                      >
                        {name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="drcal__picker">
              <button type="button" onClick={() => open('year')} aria-haspopup="listbox" aria-expanded={menu?.side === offset && menu.kind === 'year'}>
                {y}
                <i />
              </button>
              {menu?.side === offset && menu.kind === 'year' && (
                <ul className="drcal__menu" role="listbox">
                  {Array.from({ length: 6 }, (_, k) => thisYear - 4 + k).map((yr) => (
                    <li key={yr}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={yr === y}
                        onClick={() => {
                          setBase(yr * 12 + m - offset);
                          setMenu(null);
                        }}
                      >
                        {yr}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {offset === 1 ? (
            <button type="button" className="drcal__arrow" aria-label="Next month" onClick={() => setBase(base + 1)}>
              <Icon name="chevron-right" size={22} stroke={2.4} />
            </button>
          ) : (
            <span className="drcal__arrow" />
          )}
        </div>
        <div className="drcal__grid" onMouseLeave={() => setHover(null)}>
          {DAYS.map((d) => (
            <span key={d} className="drcal__dow">
              {d}
            </span>
          ))}
          {cells.map((day, i) => {
            if (day === null) return <span key={`e${i}`} />;
            const edge = day === lo || day === hi;
            const inside = day > lo && day < hi;
            return (
              <button
                key={day}
                type="button"
                className={`drcal__day${inside ? ' is-in' : ''}${edge ? ' is-edge' : ''}${day === lo && hi !== lo ? ' is-first' : ''}${day === hi && hi !== lo ? ' is-last' : ''}`}
                aria-pressed={edge}
                onMouseEnter={() => anchor !== null && setHover(day)}
                onClick={() => pick(day)}
              >
                {new Date(day).getDate()}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="daterange" ref={ref} role="dialog" aria-label="Choose a date range">
      {month(0)}
      {month(1)}
    </div>
  );
}
