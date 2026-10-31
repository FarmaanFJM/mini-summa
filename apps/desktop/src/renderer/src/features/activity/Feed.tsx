import type { ActivityEvent, LinkTarget } from '@minisumma/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefCallback } from 'react';
import { activeProjects } from '../../app/selectors';
import { useApi, useApp } from '../../app/runtime';
import { Button, EmptyState, Icon, IconButton, Menu, Select, Tag } from '../../ui';
import { formatRelative } from '../workspace/sessionModel';
import { errorText } from '../reports/support';
import { demandWords, groupByDay, isOpen, linkKey, linkWords, newestFirst, primaryLink, SEVERITY_WORDS, spoken } from './model';
import { useOpenLink } from './navigation';

export interface FeedFilters { projectId: string; unread: boolean; attention: boolean }
export const NO_FILTERS: FeedFilters = { projectId: 'all', unread: false, attention: false };
const PAGE = 50;

interface Loaded { status: 'loading' | 'ready' | 'error'; items: ActivityEvent[]; next: string | null; error: string | null }


export interface FeedProps {
  filters: FeedFilters;
  onFilters?: (filters: FeedFilters) => void;
  /** Only entries that still wait for the person ("Needs you"). Filters are not shown. */
  onlyOpen?: boolean;
  label: string;
  emptyText: string;
}

/**
 * Activity across projects, newest first, grouped by day. Pages come from the core (`before`); entries that arrive, change
 * or are read while the view is open are applied as they happen. Nothing here is an automatic action: it is a list.
 */
export function Feed({ filters, onFilters, onlyOpen = false, label, emptyText }: FeedProps) {
  const api = useApi();
  const openLink = useOpenLink();
  const syncedAt = useApp((s) => s.syncedAt);
  const projects = useApp((s) => s.projects);
  const [state, setState] = useState<Loaded>({ status: 'loading', items: [], next: null, error: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const ticket = useRef(0);
  const live = useRef({ filters, onlyOpen });
  live.current = { filters, onlyOpen };

  const requiresAction = onlyOpen || filters.attention;
  const query = useMemo(() => ({
    limit: PAGE,
    ...(!onlyOpen && filters.projectId !== 'all' ? { projectId: filters.projectId } : {}),
    ...(!onlyOpen && filters.unread ? { unread: true } : {}),
    ...(requiresAction ? { requiresAction: true } : {}),
  }), [filters.projectId, filters.unread, onlyOpen, requiresAction]);

  const load = useCallback(async (quiet: boolean) => {
    const mine = ++ticket.current;
    if (!quiet) setState((s) => ({ ...s, status: 'loading', error: null }));
    try {
      const page = await api.call('activity.list', { query });
      if (mine === ticket.current) setState({ status: 'ready', items: page.items, next: page.nextBefore, error: null });
    } catch (err) {
      if (mine === ticket.current) setState((s) => ({ ...s, status: 'error', error: errorText(err) }));
    }
  }, [api, query]);

  // A new filter starts a new list; a reload of everything (after a reconnect) refreshes it without blanking it.
  const first = useRef(true);
  const lastSynced = useRef(syncedAt);
  useEffect(() => {
    const quiet = !first.current && lastSynced.current !== syncedAt;
    first.current = false;
    lastSynced.current = syncedAt;
    void load(quiet);
  }, [load, syncedAt]);

  // Live updates, applied to the list the person is looking at.
  useEffect(() => api.events.onEvent((_seq, event) => {
    const { filters: f, onlyOpen: only } = live.current;
    const wantOpen = only || f.attention;
    const matches = (a: ActivityEvent) => (only || f.projectId === 'all' || a.projectId === f.projectId) && (only || !f.unread || !a.read) && (!wantOpen || isOpen(a));
    if (event.type === 'activity.added') {
      setState((s) => (s.status !== 'ready' || !matches(event.activity) || s.items.some((i) => i.id === event.activity.id) ? s : { ...s, items: [event.activity, ...s.items].sort(newestFirst) }));
    } else if (event.type === 'activity.updated') {
      setState((s) => {
        if (s.status !== 'ready') return s;
        const known = s.items.some((i) => i.id === event.activity.id);
        if (known) {
          // An entry that stopped waiting for the person leaves "Needs you"; elsewhere it stays and says it was handled.
          const items = wantOpen && !isOpen(event.activity) ? s.items.filter((i) => i.id !== event.activity.id) : s.items.map((i) => (i.id === event.activity.id ? event.activity : i));
          return { ...s, items };
        }
        return matches(event.activity) ? { ...s, items: [...s.items, event.activity].sort(newestFirst) } : s;
      });
    } else if (event.type === 'activity.read') {
      const ids = new Set(event.ids);
      setState((s) => (s.items.some((i) => ids.has(i.id) && !i.read) ? { ...s, items: s.items.map((i) => (ids.has(i.id) ? { ...i, read: true } : i)) } : s));
    }
  }), [api]);

  const loadMore = async () => {
    if (!state.next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.call('activity.list', { query: { ...query, before: state.next } });
      setState((s) => ({ ...s, items: [...s.items, ...page.items.filter((p) => !s.items.some((i) => i.id === p.id))], next: page.nextBefore }));
    } catch (err) {
      setMoreError(errorText(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const open = (a: ActivityEvent, link: LinkTarget | null) => {
    if (!a.read) api.call('activity.markRead', { body: { ids: [a.id] } }).catch(() => { /* the entry stays unread; opening it still works */ });
    if (link) openLink(link);
  };

  const groups = useMemo(() => groupByDay(state.items), [state.items]);
  const filtered = !onlyOpen && (filters.projectId !== 'all' || filters.unread || filters.attention);
  const choices = useMemo(() => activeProjects(projects), [projects]);

  return (
    <div className="ms-act-feed">
      {!onlyOpen && onFilters ? (
        <div className="ms-act-filters" role="group" aria-label="Filter the feed">
          <Select
            quiet
            aria-label="Project"
            value={filters.projectId}
            onChange={(projectId) => onFilters({ ...filters, projectId })}
            options={[{ value: 'all', label: 'All projects' }, ...choices.map((p) => ({ value: p.id, label: p.name }))]}
          />
          <Tag onClick={() => onFilters({ ...filters, unread: !filters.unread })} selected={filters.unread}>Unread</Tag>
          <Tag onClick={() => onFilters({ ...filters, attention: !filters.attention })} selected={filters.attention} icon="warning">Needs attention</Tag>
        </div>
      ) : null}

      {state.status === 'loading' && state.items.length === 0 ? (
        <div className="ms-skeleton-list ms-skeleton-list--wide" aria-busy="true" aria-label="Loading activity">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="ms-skeleton-row" />)}</div>
      ) : state.status === 'error' && state.items.length === 0 ? (
        <EmptyState tone="error" action={<Button onClick={() => { void load(false); }}>Try again</Button>}>Activity could not be loaded. {state.error}</EmptyState>
      ) : state.items.length === 0 ? (
        filtered && onFilters ? (
          <EmptyState action={<Button onClick={() => onFilters(NO_FILTERS)}>Clear filters</Button>}>No activity matches these filters.</EmptyState>
        ) : (
          <EmptyState>{emptyText}</EmptyState>
        )
      ) : (
        <div className="ms-act-groups" role="feed" aria-label={label} aria-busy={state.status === 'loading'}>
          {groups.map((g) => (
            <section key={g.key} className="ms-act-day" aria-label={g.label}>
              <h2 className="ms-act-day__title">{g.label}</h2>
              <ul className="ms-act-list">
                {g.items.map((a) => <FeedRow key={a.id} a={a} onOpen={open} />)}
              </ul>
            </section>
          ))}
          {state.next ? (
            <div className="ms-act-more">
              <Button loading={loadingMore} onClick={() => { void loadMore(); }}>Load older activity</Button>
              {moreError ? <p className="ms-x-error" role="alert">{moreError}</p> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function FeedRow({ a, onOpen }: { a: ActivityEvent; onOpen: (a: ActivityEvent, link: LinkTarget | null) => void }) {
  const primary = primaryLink(a.links);
  const others = useMemo(() => {
    const seen = new Set<string>();
    return a.links.filter((l) => { const k = linkKey(l); if (seen.has(k)) return false; seen.add(k); return true; });
  }, [a.links]);
  const severity = SEVERITY_WORDS[a.severity];
  const demand = demandWords(a);
  const meta = [a.projectName, severity, demand].filter((m): m is string => Boolean(m));
  const label = spoken([a.read ? null : 'Unread', a.title, a.description, ...meta, formatRelative(a.at)]);
  return (
    <li className="ms-act" data-unread={!a.read || undefined} data-severity={a.severity}>
      <button type="button" className="ms-act__main" aria-label={label} onClick={() => onOpen(a, primary)}>
        <span className="ms-act__marker" aria-hidden="true">{!a.read ? <span className="ms-dot ms-act__dot" /> : null}</span>
        <span className="ms-act__body">
          <span className="ms-act__title">{a.title}</span>
          {a.description ? <span className="ms-act__desc">{a.description}</span> : null}
          {meta.length > 0 ? (
            <span className="ms-act__meta">
              {a.severity !== 'info' ? <Icon name={a.severity === 'error' ? 'circle-alert' : 'warning'} size={14} className="ms-act__sev" /> : null}
              {meta.join(', ')}
            </span>
          ) : null}
        </span>
        <time className="ms-act__time" dateTime={a.at}>{formatRelative(a.at)}</time>
      </button>
      {others.length > 1 ? (
        <Menu
          label="Open"
          placement="bottom-end"
          trigger={(props) => (
            <IconButton
              ref={props.ref as RefCallback<HTMLButtonElement>}
              label="More places to open this entry"
              icon="more-h"
              size="sm"
              tooltip={false}
              className="ms-act__more"
              aria-haspopup="menu"
              aria-expanded={props['aria-expanded']}
              onClick={props.onClick}
              onKeyDown={props.onKeyDown}
            />
          )}
          items={others.map((l) => ({ label: linkWords(l), onSelect: () => onOpen(a, l) }))}
        />
      ) : null}
    </li>
  );
}
