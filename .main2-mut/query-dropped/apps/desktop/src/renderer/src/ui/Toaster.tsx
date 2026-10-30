import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { getNativeBounds, overlapsNativeView, toRect } from '../app/nativeBounds';
import { cx } from './cx';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import { useNativeOverlay } from './nativeOverlay';

export type ToastKind = 'neutral' | 'success' | 'info' | 'warning' | 'error';

export interface ToastInput {
  /** The message. With `body` it becomes the heading of an expanded toast. */
  title: string;
  body?: string;
  /** One text action, for example Undo or Retry. */
  action?: { label: string; onClick: () => void };
  kind?: ToastKind;
  /** Milliseconds; Infinity keeps it until dismissed. Defaults depend on the kind. */
  durationMs?: number;
  /** Same id shows one toast: a repeat restarts the timer instead of stacking. */
  id?: string;
}

interface ToastRecord {
  id: string;
  key: string;
  kind: ToastKind;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  duration: number;
  remaining: number;
  startedAt: number;
  paused: boolean;
  leaving: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const MAX_VISIBLE = 3;
const ACTION_MIN_MS = 6000;
const LEAVE_MS = 170;
const DEFAULT_MS: Record<ToastKind, number> = { neutral: 4000, success: 4000, info: 4000, warning: 8000, error: Infinity };
const KIND_ICON: Partial<Record<ToastKind, IconName>> = { success: 'circle-check', error: 'circle-x', warning: 'triangle-alert', info: 'info' };

let records: ToastRecord[] = [];
let snapshot: readonly ToastRecord[] = [];
let sequence = 0;
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = records.slice();
  for (const l of listeners) l();
}

function arm(t: ToastRecord): void {
  if (t.timer) clearTimeout(t.timer);
  t.timer = null;
  if (!Number.isFinite(t.duration) || t.leaving) return;
  t.startedAt = Date.now();
  t.timer = setTimeout(() => dismissToast(t.id), t.remaining);
}

/** Show a notification. Use it for things outside the current focus; results already visible in the UI need none. */
export function toast(input: ToastInput): string {
  const kind = input.kind ?? 'neutral';
  const key = input.id ?? [kind, input.title, input.body ?? ''].join('|');
  const existing = records.find((t) => t.key === key && !t.leaving);
  if (existing) {
    existing.remaining = existing.duration;
    existing.paused = false;
    arm(existing);
    publish();
    return existing.id;
  }
  let duration = input.durationMs ?? DEFAULT_MS[kind];
  if (input.action && Number.isFinite(duration)) duration = Math.max(duration, ACTION_MIN_MS);
  const record: ToastRecord = {
    id: `toast-${++sequence}`, key, kind, title: input.title, body: input.body, action: input.action,
    duration, remaining: duration, startedAt: Date.now(), paused: false, leaving: false, timer: null,
  };
  records = [...records, record];
  arm(record);
  publish();
  return record.id;
}

export function dismissToast(id: string): void {
  const t = records.find((r) => r.id === id);
  if (!t || t.leaving) return;
  if (t.timer) clearTimeout(t.timer);
  t.timer = null;
  t.leaving = true;
  publish();
  setTimeout(() => { records = records.filter((r) => r.id !== id); publish(); }, LEAVE_MS);
}

/** Test helper: forget every toast. */
export function resetToasts(): void {
  for (const t of records) if (t.timer) clearTimeout(t.timer);
  records = [];
  publish();
}

function pause(t: ToastRecord): void {
  if (!Number.isFinite(t.duration) || t.paused) return;
  t.paused = true;
  if (t.timer) clearTimeout(t.timer);
  t.timer = null;
  t.remaining -= Date.now() - t.startedAt;
}
function resume(t: ToastRecord): void {
  if (!t.paused) return;
  t.paused = false;
  arm(t);
}

// ---------------------------------------------------------------------------------------------------------------
// Anchor: where the region sits. The workspace anchors it to the Claude pane so toasts are not drawn under the native
// ChatGPT view; elsewhere it stays bottom centre.

let anchorEl: HTMLElement | null = null;
const anchorListeners = new Set<() => void>();
export function setToastAnchor(el: HTMLElement | null): void {
  anchorEl = el;
  for (const l of anchorListeners) l();
}
const subscribeAnchor = (l: () => void) => { anchorListeners.add(l); return () => { anchorListeners.delete(l); }; };
const getAnchor = () => anchorEl;

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getSnapshot = () => snapshot;

/** Renders the notification region. Mount it once, near the root of the app. */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const anchor = useSyncExternalStore(subscribeAnchor, getAnchor, getAnchor);
  const region = useRef<HTMLElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});
  const [overlapsNative, setOverlapsNative] = useState(false);

  const visible = list.slice(-MAX_VISIBLE - 1);
  const count = list.length;

  // Place the region over the anchor (when there is one) and find out whether the native view would cover it.
  useLayoutEffect(() => {
    const place = () => {
      let next: CSSProperties = {};
      if (anchor && anchor.isConnected) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0) {
          next = {
            left: `${Math.round(r.left + r.width / 2)}px`,
            bottom: `${Math.max(16, Math.round(window.innerHeight - r.bottom + 16))}px`,
            width: `min(440px, ${Math.max(200, Math.round(r.width - 32))}px)`,
          };
        }
      }
      setStyle((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    place();
    const ro = typeof ResizeObserver !== 'undefined' && anchor ? new ResizeObserver(place) : null;
    if (anchor) ro?.observe(anchor);
    window.addEventListener('resize', place);
    return () => { ro?.disconnect(); window.removeEventListener('resize', place); };
  }, [anchor, count]);

  useEffect(() => {
    if (count === 0 || !region.current || getNativeBounds() === null) { setOverlapsNative(false); return; }
    const r = region.current.getBoundingClientRect();
    setOverlapsNative(overlapsNativeView(toRect(r)));
  }, [count, style]);

  useNativeOverlay(count > 0 && overlapsNative);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <section ref={region} className="sm-toast-region" aria-label="Notifications" style={style}>
      {visible.map((t, i) => {
        const depth = Math.min(visible.length - 1 - i, MAX_VISIBLE);
        const expanded = Boolean(t.body);
        const icon = KIND_ICON[t.kind];
        const persistent = !Number.isFinite(t.duration);
        const urgent = t.kind === 'error' || t.kind === 'warning';
        return (
          <div
            key={t.id}
            className={cx('sm-toast', expanded ? 'sm-toast--expanded' : 'sm-toast--compact')}
            data-type={t.kind}
            data-depth={depth}
            data-state={t.leaving ? 'leaving' : undefined}
            role={urgent ? 'alert' : 'status'}
            aria-live={urgent ? 'assertive' : 'polite'}
            aria-atomic="true"
            onPointerEnter={() => pause(t)}
            onPointerLeave={() => resume(t)}
            onFocus={() => pause(t)}
            onBlur={() => resume(t)}
            onKeyDown={(e) => { if (e.key === 'Escape') dismissToast(t.id); }}
          >
            {icon ? <span className="sm-toast__icon"><Icon name={icon} /></span> : null}
            <div className="sm-toast__body">
              {expanded ? (
                <>
                  <div className="sm-toast__title">{t.title}</div>
                  <div className="sm-toast__desc">{t.body}</div>
                </>
              ) : <div className="sm-toast__message">{t.title}</div>}
              {expanded && t.action ? (
                <div className="sm-toast__actions">
                  <button type="button" className="sm-toast__action" onClick={() => { t.action?.onClick(); dismissToast(t.id); }}>{t.action.label}</button>
                </div>
              ) : null}
            </div>
            {!expanded && t.action ? (
              <button type="button" className="sm-toast__action" onClick={() => { t.action?.onClick(); dismissToast(t.id); }}>{t.action.label}</button>
            ) : null}
            {persistent || t.action ? (
              <button type="button" className="sm-toast__dismiss" aria-label="Dismiss notification" onClick={() => dismissToast(t.id)}>
                <Icon name="x" size={14} />
              </button>
            ) : null}
          </div>
        );
      })}
    </section>,
    document.body,
  );
}
