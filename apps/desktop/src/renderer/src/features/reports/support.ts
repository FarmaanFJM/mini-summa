// Small shared helpers for the four feature areas: error text, the clipboard with its fallback, and "one action at a time".
import { ApiError } from '@minisumma/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RendererNative } from '../../app/native';

/** The sentence to show for a failed call. The core words its errors for people, so they are shown as they are. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export const isApiError = (err: unknown, code: string): boolean => err instanceof ApiError && err.code === code;

export type ClipboardResult = { ok: true } | { ok: false; reason: string };

/**
 * Puts text on the clipboard through the host, then through the browser if the host refuses. Never throws: the caller
 * decides how to tell the person, because "it was copied" must only ever be said when it really was.
 */
export async function writeClipboard(native: Pick<RendererNative, 'clipboard'>, text: string): Promise<ClipboardResult> {
  let reason = 'The clipboard is not available.';
  try {
    await native.clipboard.writeText(text);
    return { ok: true };
  } catch (err) {
    reason = errorText(err);
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    }
  } catch (err) {
    reason = errorText(err);
  }
  return { ok: false, reason };
}

export interface Runner {
  /** The key of the action that is running, or null. */
  busy: string | null;
  /** The message of the last failure. Cleared when the next action starts. */
  error: string | null;
  /** Runs `fn` unless another action is already running. Resolves to undefined when it failed or was skipped. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined>;
  setError(message: string | null): void;
}

/** One action at a time with a busy marker and an error line. A second click while one runs is ignored, not queued. */
export function useRunner(): Runner {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = key;
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      if (mounted.current) setError(errorText(err));
      return undefined;
    } finally {
      running.current = null;
      if (mounted.current) setBusy(null);
    }
  }, []);

  return { busy, error, run, setError };
}
