import type { Project, SessionKey, SessionView } from '@minisumma/shared';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNative } from '../../app/native';
import { useApi, useApp, useRoute, useRuntime, useTerminals, useUi } from '../../app/runtime';
import { Button, ConfirmDialog, EmptyState, IconButton, Menu, Tabs, tabPanelProps, toast, setToastAnchor } from '../../ui';
import type { MenuEntry, TabItem } from '../../ui';
import { useHandoffStrip } from '../reports/HandoffStrip';
import { NewSessionDialog } from './NewSessionDialog';
import { ObservedPanel, SessionNotice } from './SessionPanels';
import { formatRelative, ORIGIN_LABEL, shortId, tabTitle } from './sessionModel';
import { InputBanner, StateDot } from './sessionParts';
import { pickSelectedTab, selectionAfterClose, visibleTabs } from './tabs';
import { TerminalSlot } from './TerminalSlot';
import { useSessionActions } from './useSessionActions';
import { envLabel } from '@minisumma/shared';

export interface ClaudePaneProps {
  project: Project;
  visible: boolean;
  maximized: boolean;
  onToggleMaximize: () => void;
}

export function ClaudePane({ project, visible, maximized, onToggleMaximize }: ClaudePaneProps) {
  const sessions = useApp((s) => s.sessions);
  const openTabs = useUi((s) => s.openTabs);
  const dismissed = useUi((s) => s.dismissed);
  const focused = useUi((s) => s.focusedPane === 'claude');
  const setFocusedPane = useUi((s) => s.setFocusedPane);
  const openProjectDialog = useUi((s) => s.openProjectDialog);
  const route = useRoute();
  const { ui } = useRuntime();
  const actions = useSessionActions(project);
  const root = useRef<HTMLElement>(null);
  // While the handoff strip offers its main button, an empty pane keeps its own quiet: one main action at a time (P15).
  const stripShown = useHandoffStrip(project.id) !== null;

  const tabs = useMemo(() => visibleTabs({ openTabs, dismissed }, project.id, sessions), [openTabs, dismissed, project.id, sessions]);
  const chosen = route.sessionByProject[project.id];
  const selected = pickSelectedTab(tabs, chosen, sessions);

  // A session chosen before (restored, or named by a notification) gets its tab if it belongs here.
  useEffect(() => {
    if (!chosen || tabs.some((t) => t.key === chosen)) return;
    const s = sessions.find((x) => x.key === chosen);
    if (s && (s.projectId === project.id || s.projectId === null)) ui.getState().openTab(project.id, chosen);
  }, [chosen, tabs, sessions, project.id, ui]);

  // What is shown stays shown. Without a choice the first tab is displayed, and tabs re-sort when a session stops; remembering
  // the displayed one keeps the person on the session they were looking at (and its "ended" notice) instead of jumping away.
  const { selectSession } = route;
  useEffect(() => {
    if (!selected || chosen === selected.key) return;
    if (chosen && sessions.some((x) => x.key === chosen && (x.projectId === project.id || x.projectId === null))) return; // its tab is about to open
    selectSession(project.id, selected.key);
  }, [selected, chosen, sessions, project.id, selectSession]);

  // Toasts sit over this pane, so the native ChatGPT view never covers them.
  useEffect(() => {
    if (!visible || !root.current) return undefined;
    setToastAnchor(root.current);
    return () => setToastAnchor(null);
  }, [visible]);

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [stopping, setStopping] = useState<SessionView | null>(null);

  const newSession = () => {
    if (project.roots.length === 0) {
      toast({ title: 'Add a repository folder first', body: `${project.name} has no folder to start Claude in.`, kind: 'warning' });
      openProjectDialog({ mode: 'edit', projectId: project.id });
    } else if (project.roots.length === 1) {
      void actions.start({ mode: 'new', rootId: project.roots[0].id });
    } else setNewSessionOpen(true);
  };

  const closeTab = (key: SessionKey) => {
    const after = key === selected?.key ? selectionAfterClose(tabs, key) : selected?.key ?? null;
    actions.close(key, after);
  };

  const items: TabItem[] = tabs.map((s) => ({
    id: s.key,
    title: tabTitle(s),
    leading: <StateDot session={s} />,
    label: (<><span className="ms-mono">{shortId(s)}</span><span className="ms-tab__origin">{ORIGIN_LABEL[s.origin]}</span></>),
    closable: true,
    closeLabel: `Close tab ${shortId(s)}. The session keeps running.`,
    onClose: () => closeTab(s.key),
  }));

  const resumable = sessions.filter((s) => s.projectId === project.id && s.resumable && s.availability !== 'live');
  const observed = sessions.filter((s) => s.origin !== 'managed' && (s.projectId === project.id || s.projectId === null));

  const addItems: MenuEntry[] = [
    { label: 'New session', icon: 'plus', disabled: actions.starting, onSelect: newSession },
    ...(resumable.length ? [
      { type: 'separator' } as const,
      { type: 'heading', label: 'Resume' } as const,
      ...resumable.slice(0, 8).map((s): MenuEntry => ({
        label: `${shortId(s)}, ${envLabel(s.env)}${s.lastActivityAt ? `, ${formatRelative(s.lastActivityAt)}` : ''}`,
        icon: 'history',
        disabled: actions.starting,
        onSelect: () => { void actions.start({ mode: 'resume', resumeKey: s.key }); },
      })),
    ] : []),
  ];

  const sessionItems: MenuEntry[] = [
    ...observedGroup('In this project', observed.filter((s) => s.projectId === project.id), actions.show),
    ...observedGroup('Not assigned to a project', observed.filter((s) => s.projectId === null), actions.show),
  ];

  const active = visible && selected !== null && selected.origin === 'managed' && selected.availability === 'live';

  return (
    <section
      ref={root}
      className="ms-pane ms-pane--claude"
      aria-label="Claude"
      data-focused={focused || undefined}
      onFocusCapture={() => setFocusedPane('claude')}
      onPointerDownCapture={() => setFocusedPane('claude')}
    >
      <header className="ms-pane__head">
        <span className="ms-pane__title">Claude</span>
        <Tabs
          label="Claude sessions"
          idPrefix="claude"
          items={items}
          value={selected?.key ?? null}
          onChange={(key) => actions.show(key as SessionKey)}
          trailing={(
            <Menu
              label="New or resumed session"
              trigger={(props) => (
                <IconButton ref={props.ref as (el: HTMLButtonElement | null) => void} label="New or resumed session" icon="plus" size="sm" tooltipPlacement="top" aria-haspopup="menu" aria-expanded={props['aria-expanded']} onClick={props.onClick} onKeyDown={props.onKeyDown} />
              )}
              items={addItems}
            />
          )}
        />
        <div className="ms-pane__tools">
          {sessionItems.length > 0 ? (
            <Menu
              label="Observed sessions"
              placement="bottom-end"
              trigger={(props) => (
                <Button ref={props.ref as (el: HTMLButtonElement | null) => void} size="sm" variant="ghost" iconEnd="chevron-down" aria-haspopup="menu" aria-expanded={props['aria-expanded']} onClick={props.onClick} onKeyDown={props.onKeyDown}>Sessions</Button>
              )}
              items={sessionItems}
            />
          ) : null}
          <IconButton label={maximized ? 'Restore Claude pane' : 'Maximize Claude pane'} icon={maximized ? 'minimize' : 'maximize'} size="sm" tooltipPlacement="top" pressed={maximized} onClick={onToggleMaximize} />
        </div>
      </header>

      {selected ? (
        <>
          <InputBanner
            session={selected}
            projectName={selected.projectName ?? (selected.projectId === project.id ? project.name : null)}
            actions={<SessionMenu session={selected} onStop={() => setStopping(selected)} onClose={() => closeTab(selected.key)} />}
          />
          <SessionNotice session={selected} resuming={actions.starting} onResume={() => { void actions.start({ mode: 'resume', resumeKey: selected.key }); }} />
          <div className="ms-claude__body" {...tabPanelProps('claude', selected.key)}>
            <SessionBody session={selected} active={active} resuming={actions.starting} onResume={() => { void actions.start({ mode: 'resume', resumeKey: selected.key }); }} />
          </div>
        </>
      ) : (
        <div className="ms-claude__body">
          <EmptyState
            center
            action={project.roots.length === 0
              ? <Button onClick={() => openProjectDialog({ mode: 'edit', projectId: project.id })}>Add a folder</Button>
              : <Button variant={stripShown ? 'secondary' : 'primary'} icon="plus" loading={actions.starting} onClick={newSession}>Start a session</Button>}
          >
            {project.roots.length === 0
              ? `${project.name} has no repository folder yet. Add one to start Claude in it.`
              : `No Claude session is open for ${project.name}. Start one in the project folder.`}
          </EmptyState>
        </div>
      )}

      <NewSessionDialog
        project={project}
        open={newSessionOpen}
        starting={actions.starting}
        onClose={() => setNewSessionOpen(false)}
        onStart={async ({ rootId, name }) => { const s = await actions.start({ mode: 'new', rootId, name }); if (s) setNewSessionOpen(false); }}
      />
      <StopDialog session={stopping} onClose={() => setStopping(null)} />
    </section>
  );
}

function observedGroup(heading: string, list: SessionView[], show: (key: SessionKey) => void): MenuEntry[] {
  if (list.length === 0) return [];
  return [
    { type: 'heading', label: heading },
    ...list.map((s): MenuEntry => ({
      label: `${shortId(s)}, ${ORIGIN_LABEL[s.origin]}, ${s.stateLabel}`,
      onSelect: () => show(s.key),
    })),
  ];
}

function SessionBody({ session, active, resuming, onResume }: { session: SessionView; active: boolean; resuming: boolean; onResume: () => void }) {
  const registry = useTerminals();
  const info = useSyncExternalStore(registry.subscribe, () => registry.info(session.key), () => null);
  if (session.origin !== 'managed') return <ObservedPanel session={session} resuming={resuming} onResume={onResume} />;
  if (session.availability === 'live' || info?.hasOutput) return <TerminalSlot sessionKey={session.key} active={active} />;
  return <EmptyState center>No terminal output is available for this session.</EmptyState>;
}

function SessionMenu({ session, onStop, onClose }: { session: SessionView; onStop: () => void; onClose: () => void }) {
  const api = useApi();
  const native = useNative();
  const managedLive = session.origin === 'managed' && session.availability === 'live';
  const copyId = async () => {
    try { await native.clipboard.writeText(session.sessionId); toast({ title: 'Session id copied', kind: 'success', durationMs: 2500 }); }
    catch (err) { toast({ title: 'Could not copy', body: err instanceof Error ? err.message : undefined, kind: 'error' }); }
  };
  const setDefault = async () => {
    try { await api.call('sessions.setDefault', { params: { key: session.key }, body: { isDefault: !session.isProjectDefault } }); }
    catch (err) { toast({ title: 'Could not change the default session', body: err instanceof Error ? err.message : undefined, kind: 'error' }); }
  };
  const items: MenuEntry[] = [
    ...(session.projectId && managedLive ? [{ label: session.isProjectDefault ? 'Not the default session' : 'Make default session', icon: 'star' as const, onSelect: () => { void setDefault(); } }] : []),
    { label: 'Copy session id', icon: 'copy', onSelect: () => { void copyId(); } },
    { label: 'Close tab', icon: 'x', onSelect: onClose },
    ...(managedLive ? [{ type: 'separator' } as const, { label: 'Stop session', icon: 'stop' as const, danger: true, onSelect: onStop }] : []),
  ];
  return (
    <Menu
      label={`Actions for session ${shortId(session)}`}
      placement="bottom-end"
      trigger={(props) => (
        <IconButton ref={props.ref as (el: HTMLButtonElement | null) => void} label={`Actions for session ${shortId(session)}`} icon="more-h" size="sm" tooltipPlacement="top" aria-haspopup="menu" aria-expanded={props['aria-expanded']} onClick={props.onClick} onKeyDown={props.onKeyDown} />
      )}
      items={items}
    />
  );
}

function StopDialog({ session, onClose }: { session: SessionView | null; onClose: () => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [session]);
  if (!session) return null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.call('sessions.stop', { params: { key: session.key }, body: {} });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open
      destructive
      title={`Stop session ${shortId(session)}?`}
      description="Claude Code is asked to exit, so anything it is doing stops. If Claude saved the session you can resume it later."
      confirmLabel="Stop session"
      busy={busy}
      error={error}
      onConfirm={run}
      onCancel={onClose}
    />
  );
}
