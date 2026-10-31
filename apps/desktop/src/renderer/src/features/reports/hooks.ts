// Data hooks for the reports area. The store carries summaries and deliveries (live through the event stream); the full
// report text and the delivery history are fetched when a report is opened, because they are large and rarely needed.
import { ApiError } from '@minisumma/shared';
import type { Conversation, Delivery, DeliveryDetail, Report } from '@minisumma/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { conversationsOf } from '../../app/selectors';
import { useApi, useApp } from '../../app/runtime';
import { errorText } from './support';

export type Loaded<T> =
  | { status: 'idle' | 'loading'; value: null; error: null }
  | { status: 'ready'; value: T; error: null }
  | { status: 'missing'; value: null; error: null }
  | { status: 'error'; value: null; error: string };

const IDLE = { status: 'idle', value: null, error: null } as const;

/** The full report. `reload` fetches it again (the "Try again" button). */
export function useReport(reportId: string | null): Loaded<Report> & { reload(): void } {
  const api = useApi();
  const [state, setState] = useState<Loaded<Report>>(IDLE);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!reportId) { setState(IDLE); return undefined; }
    let cancelled = false;
    setState({ status: 'loading', value: null, error: null });
    api.call('reports.get', { params: { id: reportId } }).then(
      (value) => { if (!cancelled) setState({ status: 'ready', value, error: null }); },
      (err: unknown) => {
        if (cancelled) return;
        setState(err instanceof ApiError && err.status === 404 ? { status: 'missing', value: null, error: null } : { status: 'error', value: null, error: errorText(err) });
      },
    );
    return () => { cancelled = true; };
  }, [api, reportId, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

/**
 * A delivery by id. The store has it once the delivery list has loaded and keeps it live through `delivery.upserted`;
 * until then (or if the list failed) it is fetched once.
 */
export function useDelivery(deliveryId: string | null): Delivery | null {
  const api = useApi();
  const fromStore = useApp((s) => (deliveryId ? s.deliveries.find((d) => d.id === deliveryId) ?? null : null));
  const [fetched, setFetched] = useState<Delivery | null>(null);
  useEffect(() => {
    if (!deliveryId || fromStore) return undefined;
    let cancelled = false;
    api.call('deliveries.get', { params: { id: deliveryId } }).then((d) => { if (!cancelled) setFetched(d); }, () => {});
    return () => { cancelled = true; };
  }, [api, deliveryId, fromStore]);
  return fromStore ?? (fetched && fetched.id === deliveryId ? fetched : null);
}

/** The delivery's event history, fetched again whenever the delivery changes. Stale answers are dropped. */
export function useDeliveryEvents(delivery: Pick<Delivery, 'id' | 'updatedAt'> | null): { detail: DeliveryDetail | null; error: string | null } {
  const api = useApi();
  const [state, setState] = useState<{ id: string; detail: DeliveryDetail } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const id = delivery?.id ?? null;
  const stamp = delivery?.updatedAt ?? null;
  useEffect(() => {
    if (!id) return undefined;
    const mine = ++ticket.current;
    api.call('deliveries.get', { params: { id } }).then(
      (detail) => { if (mine === ticket.current) { setState({ id, detail }); setError(null); } },
      (err: unknown) => { if (mine === ticket.current) setError(errorText(err)); },
    );
    return () => { ticket.current += 1; };
  }, [api, id, stamp]);
  return { detail: state && state.id === id ? state.detail : null, error };
}

/** The conversations mapped to a project, in the order the person set them. */
export function useProjectConversations(projectId: string | null): Conversation[] {
  const all = useApp((s) => s.conversations);
  return useMemo(() => (projectId ? conversationsOf(all, projectId) : []), [all, projectId]);
}
