import { mergeSettings } from '@minisumma/shared';
import type { Settings, SettingsPatch } from '@minisumma/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi, useApp } from '../../app/runtime';
import { errorText } from '../reports/support';

export type SaveState = { state: 'idle' | 'saving' | 'saved' } | { state: 'failed'; error: string };

export type TrackResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SaveTracker {
  status: SaveState;
  /** Runs `work` and shows saving, then saved or why it failed. Never throws: the outcome is the result. */
  track<T>(work: () => Promise<T>): Promise<TrackResult<T>>;
}

const SAVED_FOR_MS = 2500;

/** The status line of a form: saving while any save runs, saved for a moment, or the reason it failed. */
export function useSaveTracker(): SaveTracker {
  const [status, setStatus] = useState<SaveState>({ state: 'idle' });
  const inflight = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const track = useCallback(async <T,>(work: () => Promise<T>): Promise<TrackResult<T>> => {
    inflight.current += 1;
    if (timer.current) clearTimeout(timer.current);
    if (mounted.current) setStatus({ state: 'saving' });
    try {
      const value = await work();
      inflight.current -= 1;
      if (mounted.current && inflight.current === 0) {
        setStatus({ state: 'saved' });
        timer.current = setTimeout(() => setStatus((s) => (s.state === 'saved' ? { state: 'idle' } : s)), SAVED_FOR_MS);
      }
      return { ok: true, value };
    } catch (err) {
      inflight.current -= 1;
      const error = errorText(err);
      if (mounted.current) setStatus({ state: 'failed', error });
      return { ok: false, error };
    }
  }, []);

  return { status, track };
}

export interface SettingsHandle {
  /** The core's settings with the changes that are still on their way applied, so a switch answers at once. */
  settings: Settings | null;
  /** Sends a patch. Resolves to true when the core accepted it; on failure the screen goes back to what the core has. */
  save(patch: SettingsPatch): Promise<boolean>;
  status: SaveState;
}

interface Pending { id: number; patch: SettingsPatch; done: boolean }

/** How long an accepted change keeps showing while the core's own announcement of it is on its way. */
const ECHO_GRACE_MS = 3000;

/**
 * Saves settings through the core. A change shows at once (a switch is safe to show before the answer) and is taken back
 * if the core refuses; the status says saving, saved, or why it failed. Text a person typed is kept by the caller, not here.
 *
 * An accepted change keeps showing until the core's announcement of the new settings reaches this window, so a switch
 * never jumps back for the moment between the answer and the announcement.
 */
export function useSettings(): SettingsHandle {
  const api = useApi();
  const stored = useApp((s) => s.settings);
  const [pending, setPending] = useState<Pending[]>([]);
  const { status, track } = useSaveTracker();
  const counter = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const live = timers.current;
    return () => { for (const t of live) clearTimeout(t); live.clear(); };
  }, []);

  // The announcement arrived: what the core says now already includes every accepted change.
  useEffect(() => { setPending((p) => (p.some((x) => x.done) ? p.filter((x) => !x.done) : p)); }, [stored]);

  const settings = useMemo(() => {
    if (!stored) return null;
    return pending.reduce<Settings>((acc, p) => mergeSettings(acc, p.patch), stored);
  }, [stored, pending]);

  const save = useCallback(async (patch: SettingsPatch): Promise<boolean> => {
    const id = ++counter.current;
    setPending((p) => [...p, { id, patch, done: false }]);
    const result = await track(() => api.call('settings.update', { body: patch as never }));
    if (result.ok) {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, done: true } : x)));
      const t = setTimeout(() => { timers.current.delete(t); setPending((p) => p.filter((x) => x.id !== id)); }, ECHO_GRACE_MS);
      timers.current.add(t);
    } else {
      setPending((p) => p.filter((x) => x.id !== id));
    }
    return result.ok;
  }, [api, track]);

  return { settings, save, status };
}
