import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Alert, Priority } from '../data/types';
import { useStore } from '../lib/persist';
import { quietAlerts } from '../state/engine';
import { isOpen, toastStore, useAlerts, useCameras } from '../state/store';
import { Icon, type IconName } from './Icon';
import { PRIORITY_NAME } from './ui';

/** How long a new alert's pop-up stays: P1 until it is closed, P2 for 10 seconds, P3 and P4 for 5. */
const STAY_MS: Record<Priority, number | null> = { P1: null, P2: 10_000, P3: 5_000, P4: 5_000 };
/** Other messages (an escalation, a phone acknowledgement, "saved") use the same stack for a shorter time. */
const NOTE_MS = 8_000;
const NOTE_ALERT_MS = 12_000;
const TICK_MS = 250;
const MOST_SHOWN = 4;
const CARD_H = 56;
const GAP = 6; // between cards when spread out
const PEEK = 8; // how much of each card behind shows when stacked
const PEEKED = 2; // cards seen behind the top one when stacked

type Popup =
  | { kind: 'alert'; id: string; left: number | null }
  | { kind: 'note'; id: string; left: number; total: number; text: string; tone?: 'alert'; link?: string };

const iconFor = (a: Alert): IconName => {
  const t = a.title.toLowerCase();
  if (/smoke|fire|flame/.test(t)) return 'flame';
  if (/helmet|vest|jacket|ppe/.test(t)) return 'hardhat';
  if (/truck|vehicle/.test(t)) return 'truck';
  if (/person|pedestrian|worker/.test(t)) return 'walker';
  return 'warning';
};
const noteIcon = (text: string, tone?: 'alert'): IconName => (/escalated/i.test(text) ? 'arrow-up' : tone === 'alert' ? 'warning' : 'check');

/** Every notification of the console, at the top right of each page: new alerts and messages such as an escalation. They sit
 *  stacked, newest on top; point at them to spread out up to four with a Clear all / View all bar. Timed ones show a line
 *  filling up and wait while you point at them. */
export function AlertPopups() {
  const alerts = useAlerts();
  const cams = useCameras();
  const toasts = useStore(toastStore);
  const nav = useNavigate();
  const seen = useRef<Set<string>>(new Set(alerts.map((a) => a.id))); // alerts already there on load are not announced
  const [popups, setPopups] = useState<Popup[]>([]);
  const [hover, setHover] = useState(false);
  const leaving = useRef<number>(0);
  const point = (on: boolean) => {
    window.clearTimeout(leaving.current);
    // A short grace period when the pointer leaves, so the stack does not flicker at the card edges.
    if (on) setHover(true);
    else leaving.current = window.setTimeout(() => setHover(false), 180);
  };

  useEffect(() => {
    const fresh = alerts.filter((a) => !seen.current.has(a.id));
    if (!fresh.length) return;
    fresh.forEach((a) => seen.current.add(a.id));
    const loud = fresh.filter((a) => !quietAlerts.has(a.id));
    if (!loud.length) return;
    setPopups((p) => [...loud.map((a): Popup => ({ kind: 'alert', id: a.id, left: STAY_MS[a.priority] })), ...p]);
  }, [alerts]);

  // Messages raised with toast() move into the stack and out of the toast list.
  useEffect(() => {
    if (!toasts.length) return;
    const ms = (t: (typeof toasts)[number]) => (t.tone ? NOTE_ALERT_MS : NOTE_MS);
    setPopups((p) => [...toasts.map((t): Popup => ({ kind: 'note', id: t.id, left: ms(t), total: ms(t), text: t.text, tone: t.tone, link: t.link })), ...p]);
    toastStore.set(() => []);
  }, [toasts]);

  // Time runs down only while the pointer is away.
  useEffect(() => {
    if (hover || !popups.some((p) => p.left !== null)) return;
    const t = window.setInterval(() => setPopups((list) => list.map((p) => (p.left === null ? p : { ...p, left: p.left - TICK_MS })).filter((p) => p.left === null || p.left > 0)), TICK_MS);
    return () => window.clearInterval(t);
  }, [hover, popups]);

  // An alert's pop-up also goes when the alert is no longer waiting for anyone.
  const byId = new Map(alerts.map((a) => [a.id, a]));
  const live = popups.filter((p) => {
    if (p.kind === 'note') return true;
    const a = byId.get(p.id);
    return a && isOpen(a) && a.state !== 'acknowledged';
  });
  useEffect(() => {
    if (live.length !== popups.length) setPopups(live);
  }, [live.length, popups.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!live.length) setHover(false);
  }, [live.length]);
  if (!live.length) return null;
  const camById = new Map(cams.map((c) => [c.id, c]));
  const dismiss = (id: string) => setPopups((p) => p.filter((x) => x.id !== id));
  const shown = live.slice(0, MOST_SHOWN);

  return (
    <div className={`apop${hover ? ' is-open' : ''}`} role="region" aria-label="Notifications" aria-live="polite" onMouseEnter={() => point(true)} onMouseLeave={() => point(false)} onFocus={() => point(true)} onBlur={() => point(false)}>
      <ul className="apop__list" style={{ height: hover ? shown.length * CARD_H + (shown.length - 1) * GAP : CARD_H + Math.min(shown.length - 1, PEEKED) * PEEK }}>
        {shown.map((p, i) => {
          const a = p.kind === 'alert' ? (byId.get(p.id) as Alert) : undefined;
          const cam = a ? camById.get(a.cameraId) : undefined;
          const level = a ? a.priority : p.kind === 'note' && p.tone === 'alert' ? 'P1' : 'OK';
          const total = a ? STAY_MS[a.priority] : p.kind === 'note' ? p.total : null;
          const link = a ? `/alerts/${a.id}` : p.kind === 'note' ? p.link : undefined;
          return (
            <li
              key={p.id}
              className={`apop__item apop__item--${level}`}
              style={{ zIndex: shown.length - i, opacity: hover || i <= PEEKED ? 1 : 0, transform: hover ? `translateY(${i * (CARD_H + GAP)}px)` : `translateY(${Math.min(i, PEEKED) * PEEK}px) scale(${1 - Math.min(i, PEEKED) * 0.045})` }}
            >
              <Icon name={a ? iconFor(a) : noteIcon((p as Extract<Popup, { kind: 'note' }>).text, (p as Extract<Popup, { kind: 'note' }>).tone)} size={20} stroke={1.5} />
              <div className="apop__text">
                {a ? (
                  <>
                    <strong className="apop__title">{a.title}</strong>
                    <span className="apop__sub">
                      {a.priority} {PRIORITY_NAME[a.priority]} · {cam?.id} · {cam?.name}
                    </span>
                  </>
                ) : (
                  <strong className="apop__title apop__title--wrap">{(p as Extract<Popup, { kind: 'note' }>).text}</strong>
                )}
              </div>
              {link && (
                <button
                  type="button"
                  className="apop__view"
                  onClick={() => {
                    dismiss(p.id);
                    nav(link);
                  }}
                >
                  View
                </button>
              )}
              <button type="button" className="apop__x" aria-label="Dismiss" onClick={() => dismiss(p.id)}>
                <Icon name="close" size={16} />
              </button>
              {total !== null && p.left !== null && <span className="apop__progress" style={{ width: `${(1 - p.left / total) * 100}%` }} />}
            </li>
          );
        })}
      </ul>
      <div className="apop__foot">
        <span>
          {live.length} notification{live.length === 1 ? '' : 's'}
        </span>
        <button type="button" onClick={() => setPopups([])}>
          Clear all
        </button>
        <button
          type="button"
          onClick={() => {
            setPopups([]);
            nav('/alerts');
          }}
        >
          View all
        </button>
      </div>
    </div>
  );
}
