// Layout preferences: the core's settings are the source of truth; localStorage keeps the last values for when the core
// cannot be reached or has not answered yet. Changes show at once and are sent to the core after a short pause, so
// dragging a divider produces one request, not hundreds.
import { defaultSettings } from '@minisumma/shared';
import type { LayoutPrefs } from '@minisumma/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readJson, writeJson } from '../../app/storage';
import type { KeyValueStorage } from '../../app/storage';
import { useApi, useApp, useRuntime } from '../../app/runtime';
import { clampRatio } from './layout';

const STORAGE_KEY = 'minisumma.layout.v1';
export const SAVE_DELAY_MS = 400;

const ORIENTATIONS = ['auto', 'landscape', 'portrait'] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Accept only well-formed values from storage; anything else is ignored rather than trusted. */
export function sanitizeLayout(raw: unknown): Partial<LayoutPrefs> | null {
  if (!isRecord(raw)) return null;
  const out: Partial<LayoutPrefs> = {};
  if (typeof raw.orientation === 'string' && (ORIENTATIONS as readonly string[]).includes(raw.orientation)) out.orientation = raw.orientation as LayoutPrefs['orientation'];
  if (typeof raw.landscapeRatio === 'number') out.landscapeRatio = clampRatio(raw.landscapeRatio);
  if (typeof raw.portraitRatio === 'number') out.portraitRatio = clampRatio(raw.portraitRatio);
  if (raw.maximized === null || raw.maximized === 'chatgpt' || raw.maximized === 'claude') out.maximized = raw.maximized;
  if (typeof raw.sidebarWidth === 'number' && raw.sidebarWidth >= 180 && raw.sidebarWidth <= 520) out.sidebarWidth = raw.sidebarWidth;
  if (typeof raw.sidebarCollapsed === 'boolean') out.sidebarCollapsed = raw.sidebarCollapsed;
  return out;
}

export function readStoredLayout(storage: KeyValueStorage): Partial<LayoutPrefs> | null {
  return readJson(storage, STORAGE_KEY, sanitizeLayout);
}

export interface LayoutController {
  layout: LayoutPrefs;
  /** Apply a change now; it is stored locally at once and sent to the core after a short pause. */
  update(patch: Partial<LayoutPrefs>): void;
}

export function useLayoutPrefs(): LayoutController {
  const api = useApi();
  const { storage } = useRuntime();
  const server = useApp((s) => s.settings?.layout ?? null);
  const [pending, setPending] = useState<Partial<LayoutPrefs>>({});
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stored = useMemo(() => readStoredLayout(storage), [storage]);

  const layout = useMemo<LayoutPrefs>(() => ({ ...defaultSettings().layout, ...(server ?? stored ?? {}), ...pending }), [server, stored, pending]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const flush = useCallback(() => {
    timer.current = null;
    const patch = pendingRef.current;
    if (Object.keys(patch).length === 0) return;
    api.call('settings.update', { body: { layout: patch } }).then(
      () => setPending((p) => {
        // Keep anything the person changed again while the request was in flight.
        const rest = { ...p };
        for (const [k, v] of Object.entries(patch)) if ((rest as Record<string, unknown>)[k] === v) delete (rest as Record<string, unknown>)[k];
        return rest;
      }),
      () => { /* the core is unreachable: the choice stays on screen and in localStorage */ },
    );
  }, [api]);

  const update = useCallback((patch: Partial<LayoutPrefs>) => {
    const clean: Partial<LayoutPrefs> = { ...patch };
    if (clean.landscapeRatio !== undefined) clean.landscapeRatio = clampRatio(clean.landscapeRatio);
    if (clean.portraitRatio !== undefined) clean.portraitRatio = clampRatio(clean.portraitRatio);
    setPending((p) => ({ ...p, ...clean }));
    pendingRef.current = { ...pendingRef.current, ...clean };
    writeJson(storage, STORAGE_KEY, { ...layoutRef.current, ...clean });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  }, [flush, storage]);

  // The core echoes our own change back as settings.changed; once it matches, the local override is no longer needed.
  useEffect(() => {
    if (!server) return;
    setPending((p) => {
      const rest = { ...p } as Record<string, unknown>;
      let changed = false;
      for (const [k, v] of Object.entries(p)) if ((server as unknown as Record<string, unknown>)[k] === v) { delete rest[k]; changed = true; }
      return changed ? (rest as Partial<LayoutPrefs>) : p;
    });
  }, [server]);

  // Leaving with a change not yet sent: send it now.
  useEffect(() => () => {
    if (timer.current) { clearTimeout(timer.current); flush(); }
  }, [flush]);

  return { layout, update };
}
