// How a field of the project settings reaches the core. There is no draft and no Save: a value is sent when the person finishes
// with it (Enter, or leaving the field), the core's answer is shown beside the field, and what the person typed stays in the
// field when the core says no. Closing the dialog first asks every field to finish, so nothing typed can be left behind.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, RefObject } from 'react';

/** How long "Saved" stays next to a heading. */
export const SAVED_MS = 2000;

/** The words of a failure for the person: the core's own message when it sent one. */
export const failureText = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err));

/**
 * What reading a typed text decides. A refusal says what is wrong; `quiet` keeps it unsaid until the person has tried to finish
 * (an empty required field, a path that is waiting for an answer) because something else on screen already explains it.
 */
export type Check<T> = { ok: true; value: T; shown: string } | { ok: false; message: string; quiet?: boolean };

// ---------------------------------------------------------------------------------------------------------------
// "Saved": one quiet word that goes away by itself.

export function useSavedFlag(ms: number = SAVED_MS): { saved: boolean; flash: () => void } {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback(() => {
    setSaved(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; setSaved(false); }, ms);
  }, [ms]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { saved, flash };
}

// ---------------------------------------------------------------------------------------------------------------
// Finishing: what closing the dialog asks of every field.

/** Sends whatever the field still holds. True when nothing is left behind; false when the field could not (it says why itself). */
export type Flush = () => Promise<boolean>;

export interface FlushRegistry { register(flush: Flush): () => void }

const FlushContext = createContext<FlushRegistry | null>(null);
export const FlushProvider = FlushContext.Provider;

/** Makes a field part of closing: the dialog calls `flush` before it goes away and stays open when it answers false. */
export function useRegisterFlush(flush: Flush): void {
  const registry = useContext(FlushContext);
  const latest = useRef(flush);
  latest.current = flush;
  useEffect(() => registry?.register(() => latest.current()), [registry]);
}

/** Runs one thing after another, so a field that is finished twice (Enter, then leaving it) sends once. */
function useQueue(): <R>(task: () => Promise<R>) => Promise<R> {
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  return useCallback(<R,>(task: () => Promise<R>): Promise<R> => {
    const next = tail.current.then(task, task);
    tail.current = next.catch(() => undefined);
    return next;
  }, []);
}

// ---------------------------------------------------------------------------------------------------------------
// A field that shows a value of the project and changes it: name, repository, a title.

export interface CommitTextOptions<T> {
  /** What the core holds now, as text. Empty when there is none. */
  saved: string;
  check(text: string): Check<T>;
  /** Sends the value. Rejects with the core's words when it is refused. */
  apply(value: T): Promise<void>;
  onSaved?(): void;
}

export interface CommitText {
  /** Spread on the input. */
  inputProps: {
    value: string;
    onChange(event: ChangeEvent<HTMLInputElement>): void;
    onBlur(): void;
    onKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
    ref: RefObject<HTMLInputElement | null>;
  };
  text: string;
  /** What to say beside the field: the core's refusal, else what is wrong with the text. */
  error: string | null;
  busy: boolean;
  /** Sends the text if it is a change. True when nothing is left to send. */
  commit(): Promise<boolean>;
  /** Puts the saved value back. */
  revert(): void;
}

export function useCommitText<T>(options: CommitTextOptions<T>): CommitText {
  const { saved } = options;
  const [text, setText] = useState(saved);
  const [attempted, setAttempted] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const enqueue = useQueue();

  const latest = useRef({ ...options, text });
  latest.current = { ...options, text };
  // What the core is known to hold: the value it last gave, or what it last accepted from here.
  const baseline = useRef(saved);

  // The core changed the value (another window, or an answer to this one): follow it unless the person is in the middle of an edit.
  useEffect(() => {
    if (saved === baseline.current) return;
    setText((current) => (current === baseline.current ? saved : current));
    baseline.current = saved;
  }, [saved]);

  const commit = useCallback((): Promise<boolean> => enqueue(async () => {
    const { check, apply, onSaved, text: typed } = latest.current;
    const read = check(typed);
    if (!read.ok) { setAttempted(true); return false; }
    if (read.shown === baseline.current) {
      if (typed !== read.shown) setText(read.shown);
      setRefusal(null);
      return true;
    }
    setBusy(true);
    setRefusal(null);
    try {
      await apply(read.value);
      baseline.current = read.shown;
      setText((current) => (current === typed ? read.shown : current));
      onSaved?.();
      return true;
    } catch (err) {
      setRefusal(failureText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }), [enqueue]);

  const revert = useCallback(() => {
    setText(baseline.current);
    setAttempted(false);
    setRefusal(null);
  }, []);

  const flush = useCallback(async () => {
    const ok = await commit();
    if (!ok) inputRef.current?.focus();
    return ok;
  }, [commit]);
  useRegisterFlush(flush);

  const reading = options.check(text);
  const invalid = !reading.ok && (attempted || !reading.quiet) ? reading.message : null;
  return {
    inputProps: {
      value: text,
      ref: inputRef,
      onChange: (event) => { setText(event.target.value); setAttempted(false); setRefusal(null); },
      onBlur: () => { void commit(); },
      onKeyDown: (event) => {
        if (event.key === 'Enter') { event.preventDefault(); void commit(); return; }
        // Escape closes the dialog, and closing sends what is typed. A text that cannot be sent (an empty name, a repository that is
        // not owner/repo) would only keep the dialog open, so Escape takes that back first and a second Escape closes.
        const { check, text: typed } = latest.current;
        if (event.key === 'Escape' && typed !== baseline.current && !check(typed).ok) { event.preventDefault(); event.stopPropagation(); revert(); }
      },
    },
    text,
    error: refusal ?? invalid,
    busy,
    commit,
    revert,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// A field that adds something to the project: a folder, a conversation, the address of a ChatGPT Project.
// It is finished by Enter or its button, not by leaving it, because a half-typed path is not yet a choice.

export interface AddTextOptions<T> {
  check(text: string): Check<T>;
  /** Sends the value. Rejects with the core's words when it is refused. */
  apply(value: T): Promise<void>;
  onSaved?(): void;
}

export interface AddText<T> {
  inputProps: {
    value: string;
    onChange(event: ChangeEvent<HTMLInputElement>): void;
    onKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
    ref: RefObject<HTMLInputElement | null>;
  };
  text: string;
  setText(text: string): void;
  error: string | null;
  busy: boolean;
  /** Sends what is typed, if anything is. True when nothing is left to send. */
  commit(): Promise<boolean>;
  /**
   * Sends a value that did not come from the text (a folder chosen with Browse). When the core refuses it, `keep` is put in the field
   * so the refusal has the value it is about beside it.
   */
  send(value: T, keep?: string): Promise<boolean>;
  /** Says why something could not be added, beside the field. */
  refuse(message: string): void;
  clear(): void;
}

export function useAddText<T>(options: AddTextOptions<T>): AddText<T> {
  const [text, setText] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const enqueue = useQueue();
  const latest = useRef({ ...options, text });
  latest.current = { ...options, text };
  // Counts every change the person makes to the text, so that what was typed while the core was answering is told from what was sent
  // even when it is the same words.
  const edits = useRef(0);

  /** Sends one value. Runs inside the queue: whatever called it already waited for what was on its way before. */
  const run = useCallback(async (value: T, typed: string | null, keep?: string): Promise<boolean> => {
    setBusy(true);
    setRefusal(null);
    const started = edits.current;
    try {
      await latest.current.apply(value);
      // Only what was sent is cleared: text typed while the core was answering stays.
      if (typed === null || edits.current === started) setText('');
      setAttempted(false);
      latest.current.onSaved?.();
      return true;
    } catch (err) {
      if (keep !== undefined) setText(keep);
      setRefusal(failureText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const send = useCallback((value: T, keep?: string): Promise<boolean> => enqueue(() => run(value, null, keep)), [enqueue, run]);

  // Waits for anything already on its way (a folder chosen with Browse), then reads what is typed as it is now.
  const commit = useCallback((): Promise<boolean> => enqueue(async () => {
    const typed = latest.current.text;
    if (typed.trim() === '') return true;
    const read = latest.current.check(typed);
    if (!read.ok) { setAttempted(true); return false; }
    return run(read.value, typed);
  }), [enqueue, run]);

  const flush = useCallback(async () => {
    const ok = await commit();
    if (!ok) inputRef.current?.focus();
    return ok;
  }, [commit]);
  useRegisterFlush(flush);

  const reading = text.trim() === '' ? null : options.check(text);
  const invalid = reading && !reading.ok && (attempted || !reading.quiet) ? reading.message : null;
  return {
    inputProps: {
      value: text,
      ref: inputRef,
      onChange: (event) => { edits.current += 1; setText(event.target.value); setAttempted(false); setRefusal(null); },
      onKeyDown: (event) => {
        if (event.key === 'Enter') { event.preventDefault(); void commit(); return; }
        // As for a field that edits: Escape closes the dialog and so adds what is typed, unless that cannot be added, in which case
        // Escape clears it first and a second Escape closes.
        const { check, text: typed } = latest.current;
        if (event.key === 'Escape' && typed.trim() !== '' && !check(typed).ok) { event.preventDefault(); event.stopPropagation(); edits.current += 1; setText(''); setAttempted(false); setRefusal(null); }
      },
    },
    text,
    setText: (next) => { edits.current += 1; setText(next); setAttempted(false); setRefusal(null); },
    error: refusal ?? invalid,
    busy,
    commit,
    send,
    refuse: (message) => setRefusal(message),
    clear: () => { edits.current += 1; setText(''); setAttempted(false); setRefusal(null); },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Work started by a button: removing, choosing, unlinking. Closing the dialog waits for it, so a refusal that arrives
// after the person pressed Done is still seen, beside the control, with the dialog still open.

/** Wraps an action that answers true when the core accepted it. Its refusal is shown by the action itself. */
export function useTrack(): (task: () => Promise<boolean>) => Promise<boolean> {
  const pending = useRef(new Set<Promise<boolean>>());
  const track = useCallback((task: () => Promise<boolean>): Promise<boolean> => {
    const promise = task();
    pending.current.add(promise);
    const forget = () => { pending.current.delete(promise); };
    promise.then(forget, forget);
    return promise;
  }, []);
  const settle = useCallback(async () => (await Promise.all([...pending.current].map((p) => p.catch(() => false)))).every(Boolean), []);
  useRegisterFlush(settle);
  return track;
}
