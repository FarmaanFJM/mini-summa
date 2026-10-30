// Putting the projects in the order the person wants them: drag a row to a new place, or press Alt+Up and Alt+Down on the focused one.
// The order is the core's (`projects.reorder`, then `sortOrder`); what is kept here is only what the person did, until the core says the same.
import type { Project } from '@minisumma/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useApi } from '../../app/runtime';
import { toast } from '../../ui';

/** `ids` with `id` taken out and put at index `to` (clamped to the list). */
export function moveId(ids: readonly string[], id: string, to: number): string[] {
  const rest = ids.filter((x) => x !== id);
  if (rest.length === ids.length) return [...ids];
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
  return rest;
}

/** The order after `dragged` is dropped just before or just after `target`. */
export function dropOrder(ids: readonly string[], dragged: string, target: string, after: boolean): string[] {
  if (dragged === target) return [...ids];
  const rest = ids.filter((x) => x !== dragged);
  const at = rest.indexOf(target);
  if (at < 0 || rest.length === ids.length) return [...ids];
  rest.splice(after ? at + 1 : at, 0, dragged);
  return rest;
}

export const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** `projects` in the order of `ids`; projects that `ids` does not name keep their place at the end. */
export function orderBy(projects: readonly Project[], ids: readonly string[]): Project[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const named = ids.map((id) => byId.get(id)).filter((p): p is Project => p !== undefined);
  return [...named, ...projects.filter((p) => !ids.includes(p.id))];
}

/** How long a change made here is kept on screen while the core's announcement of it is on its way. */
export const PENDING_MS = 4000;

export interface DragState { id: string; over: string | null; after: boolean }

export interface RowOrdering {
  /** Whether this row can be moved at all (there is somewhere to move it to). */
  movable: boolean;
  dragging: boolean;
  /** Where a dragged row would land relative to this one. */
  drop: 'before' | 'after' | null;
  onDragStart: (e: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  /** Alt+Up and Alt+Down: one place up or down. */
  move: (delta: -1 | 1) => void;
}

export function useProjectOrder(active: readonly Project[]) {
  const api = useApi();
  const [pending, setPending] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const focusAfter = useRef<string | null>(null);

  const ids = useMemo(() => active.map((p) => p.id), [active]);
  const shown = useMemo(() => (pending ? orderBy(active, pending) : active), [active, pending]);
  const shownIds = useMemo(() => shown.map((p) => p.id), [shown]);

  // Once the core says the same thing, or after a while, what was done here is no longer needed.
  useEffect(() => {
    if (!pending) return undefined;
    if (sameOrder(ids, pending)) { setPending(null); return undefined; }
    const timer = setTimeout(() => setPending(null), PENDING_MS);
    return () => clearTimeout(timer);
  }, [ids, pending]);

  // A row that was moved by the keyboard keeps the keyboard: moving it in the document drops focus.
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    document.querySelector<HTMLElement>(`[data-project-id="${id}"]`)?.focus({ preventScroll: true });
  });

  const commit = useCallback(async (next: string[], said: string) => {
    setPending(next);
    setAnnouncement(said);
    try {
      await api.call('projects.reorder', { body: { ids: next } });
    } catch (err) {
      setPending(null);
      toast({ title: 'Could not change the order', body: err instanceof Error ? err.message : undefined, kind: 'error' });
    }
  }, [api]);

  const nameOf = useCallback((id: string) => active.find((p) => p.id === id)?.name ?? '', [active]);

  const forRow = useCallback((id: string): RowOrdering => {
    const here = shownIds.indexOf(id);
    const over = drag?.over === id && drag.id !== id;
    return {
      movable: shownIds.length > 1,
      dragging: drag?.id === id,
      drop: over ? (drag.after ? 'after' : 'before') : null,
      onDragStart: (e) => {
        if (shownIds.length < 2) { e.preventDefault(); return; }
        e.dataTransfer?.setData('text/plain', id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        setDrag({ id, over: null, after: false });
      },
      onDragOver: (e) => {
        if (!drag) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const box = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > box.top + box.height / 2;
        if (drag.over !== id || drag.after !== after) setDrag({ ...drag, over: id, after });
      },
      onDrop: (e) => {
        if (!drag) return;
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        const after = e.clientY > box.top + box.height / 2;
        const next = dropOrder(shownIds, drag.id, id, after);
        setDrag(null);
        if (!sameOrder(next, shownIds)) void commit(next, `${nameOf(drag.id)} moved to position ${next.indexOf(drag.id) + 1} of ${next.length}`);
      },
      onDragEnd: () => setDrag(null),
      move: (delta) => {
        const to = here + delta;
        if (here < 0 || to < 0 || to >= shownIds.length) return;
        focusAfter.current = id;
        void commit(moveId(shownIds, id, to), `${nameOf(id)} moved to position ${to + 1} of ${shownIds.length}`);
      },
    };
  }, [commit, drag, nameOf, shownIds]);

  return { shown, forRow, announcement };
}
