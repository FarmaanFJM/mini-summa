import type { Project, SessionKey, SessionView } from '@minisumma/shared';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNative } from '../../app/native';
import { useApi, useApp, useRoute, useRuntime, useTerminals, useUi } from '../../app/runtime';
import { Button, ConfirmDialog, EmptyState, Icon, IconButton, Menu, Tabs, tabPanelProps, toast, setToastAnchor } from '../../ui';
import type { MenuEntry, TabItem } from '../../ui';
import { useHandoffStrip } from '../reports/HandoffStrip';
import { ClaudeEmpty } from './ClaudeEmpty';
import { claudeStart, CLOUD_TAB_ID, hasCloudTab } from './claudeCloud';
import { CloudPanel } from './CloudPanel';
import { NewSessionDialog } from './NewSessionDialog';
import { ObservedPanel, SessionNotice } from './SessionPanels';
import { formatRelative, ORIGIN_LABEL, shortId, tabTitle } from './sessionModel';
import { InputBanner, StateDot } from './sessionParts';
import { pickSelectedTab, selectionAfterClose, visibleTabs } from './tabs';
import { TerminalSlot } from './TerminalSlot';
import { useSessionActions } from './useSessionActions';
import { envLabel, shortSessionId } from '@minisumma/shared';

export interface ClaudePaneProps {
  project: Project;
  /** On screen: the workspace is the current view and the other pane is not shown alone. */
  visible: boolean;
}

export function ClaudePane({ project, visible }: ClaudePaneProps) {
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
  // The project the one Claude Code view was last given to (see CloudPanel).
  const cloudOwner = useRef<string | null>(null);

  const tabs = useMemo(() => visibleTabs({ openTabs, dismissed }, project.id, sessions), [openTabs, dismissed, project.id, sessions]);
  const chosen = route.sessionByProject[project.id];
  const selected = pickSelectedTab(tabs, chosen, sessions);

  // The Cloud tab: there when the project has a GitHub repository, or a page of Claude Code on the web is remembered for it. Which of
  // the tabs shows is in memory only (the route keeps the session the person chose; it never holds the Cloud tab).
  const remembered = route.cloudUrlByProject[project.id];
  const cloudTab = hasCloudTab(project, remembered);
  const cloudChosen = route.cloudShown[project.id] === true;
  const cloudShown = cloudTab && cloudChosen;

  // A Cloud tab that went away (the repository was removed) is not the tab that is shown: the local session is, and the core is told so.
  const { hideCloud } = route;
  useEffect(() => { if (cloudChosen && !cloudTab) hideCloud(project.id); }, [cloudChosen, cloudTab, hideCloud, project.id]);

  // A session chosen before (restored, or named by a notification) gets its tab if it belongs here.
  useEffect(() => {
    if (!chosen || tabs.some((t) => t.key === chosen)) return;
    const s = sessions.find((x) => x.key === chosen);
    if (s && (s.projectId === project.id || s.projectId === null)) ui.getState().openTab(project.id, chosen);
  }, [chosen, tabs, sessions, project.id, ui]);

  // What is shown stays shown. Without a choice the first tab is displayed, and tabs re-sort when a session stops; remembering
  // the displayed one keeps the person on the session they were looking at (and its "ended" notice) instead of jumping away.
  // While the Cloud tab is shown no session is displayed, and choosing one would take the pane away from it.
  const { selectSession } = route;
  useEffect(() => {
    if (cloudShown || !selected || chosen === selected.key) return;
    if (chosen && sessions.some((x) => x.key === chosen && (x.projectId === project.id || x.projectId === null))) return; // its tab is about to open
    selectSession(project.id, selected.key);
  }, [cloudShown, selected, chosen, sessions, project.id, selectSession]);

  // Toasts sit over this pane, so the native ChatGPT view never covers them. While the Cloud tab shows Claude Code on the web, that page
  // fills the pane, so they sit over the part of the tab above it.
  const [cloudTop, setCloudTop] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!visible || !root.current) return undefined;
    setToastAnchor(cloudShown && cloudTop ? cloudTop : root.current);
    return () => setToastAnchor(null);
  }, [visible, cloudShown, cloudTop]);

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [stopping, setStopping] = useState<SessionView | null>(null);

  const openSettings = () => openProjectDialog({ mode: 'edit', projectId: project.id });

  // Local and cloud are separate choices. Asking for one never starts the other, and one that cannot start is not offered as a start.
  const choices = claudeStart(project);
  const newLocal = () => {
    if (!choices.local.available) return;
    if (project.roots.length === 1) void actions.start({ mode: 'new', rootId: project.roots[0].id });
    else setNewSessionOpen(true);
  };
  const newCloud = () => {
    if (!choices.cloud.available) return;
    route.showCloud(project.id, { start: true });
  };

  const closeTab = (key: SessionKey) => {
    const after = key === selected?.key ? selectionAfterClose(tabs, key) : selected?.key ?? null;
    actions.close(key, after, { keepCloud: cloudShown }); // closing a session tab does not take the pane away from the Cloud tab
  };

  const sessionItems: TabItem[] = tabs.map((s) => ({
    id: s.key,
    title: tabTitle(s),
    leading: <StateDot session={s} />,
    label: (<><span className="ms-mono">{shortId(s)}</span><span className="ms-tab__origin">{ORIGIN_LABEL[s.origin]}</span></>),
    closable: true,
    closeLabel: `Close tab ${shortId(s)}. The session keeps running.`,
    onClose: () => closeTab(s.key),
  }));
  const items: TabItem[] = cloudTab
    ? [...sessionItems, { id: CLOUD_TAB_ID, title: 'Cloud, Claude Code on the web', leading: <Icon name="cloud" />, label: 'Cloud' }]
    : sessionItems;

  const resumable = sessions.filter((s) => s.projectId === project.id && s.resumable && s.availability !== 'live');
  const observed = sessions.filter((s) => s.origin !== 'managed' && (s.projectId === project.id || s.projectId === null));

  const addItems: MenuEntry[] = [
    { label: 'New local session', icon: 'terminal', description: choices.local.reason ?? undefined, disabled: !choices.local.available || actions.starting, onSelect: newLocal },
    { label: 'New cloud session', icon: 'cloud', description: choices.cloud.reason ?? undefined, disabled: !choices.cloud.available, onSelect: newCloud },
    ...(choices.fix ? [
      { type: 'separator' } as const,
      { label: choices.fix, icon: 'settings', onSelect: openSettings } as MenuEntry,
    ] : []),
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

  // Sessions whose terminal went on as another session (/clear, /resume inside it): ended history, newest first.
  const replaced = sessions
    .filter((s) => s.origin === 'managed' && s.replacedBy && s.projectId === project.id)
    .sort((a, b) => (b.lastActivityAt ?? b.startedAt ?? '').localeCompare(a.lastActivityAt ?? a.startedAt ?? ''))
    .slice(0, 10);

  const observedItems: MenuEntry[] = [
    ...observedGroup('In this project', observed.filter((s) => s.projectId === project.id), actions.show),
    ...observedGroup('Not assigned to a project', observed.filter((s) => s.projectId === null), actions.show),
    ...historyGroup('Replaced inside their terminal', replaced, actions.showHistory),
  ];

  const shownSession = cloudShown ? null : selected;
  const active = visible && shownSession !== null && shownSession.origin === 'managed' && shownSession.availability === 'live';

  const showTab = (id: string) => {
    if (id === CLOUD_TAB_ID) route.showCloud(project.id);
    else actions.show(id as SessionKey);
  };

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
          value={cloudShown ? CLOUD_TAB_ID : shownSession?.key ?? null}
          onChange={showTab}
        />
        {/* Beside the tabs, not in their scrolling row: with many tabs, or a narrow pane, it must stay where it is. */}
        <Menu
          label="New session"
          trigger={(props) => (
            <IconButton className="ms-pane__add" ref={props.ref as (el: HTMLButtonElement | null) => void} label="New session" icon="plus" size="sm" tooltipPlacement="top" aria-haspopup="menu" aria-expanded={props['aria-expanded']} onClick={props.onClick} onKeyDown={props.onKeyDown} />
          )}
          items={addItems}
        />
        <div className="ms-pane__tools">
          {observedItems.length > 0 ? (
            <Menu
              label="Observed sessions"
              placement="bottom-end"
              trigger={(props) => (
                <Button ref={props.ref as (el: HTMLButtonElement | null) => void} size="sm" variant="ghost" iconEnd="chevron-down" aria-haspopup="menu" aria-expanded={props['aria-expanded']} onClick={props.onClick} onKeyDown={props.onKeyDown}>Sessions</Button>
              )}
              items={observedItems}
            />
          ) : null}
        </div>
      </header>

      {cloudShown ? (
        <CloudPanel key={project.id} project={project} active={visible} owner={cloudOwner} quiet={stripShown} onTop={setCloudTop} />
      ) : shownSession ? (
        <>
          <InputBanner
            session={shownSession}
            projectName={shownSession.projectName ?? (shownSession.projectId === project.id ? project.name : null)}
            actions={<SessionMenu session={shownSession} onStop={() => setStopping(shownSession)} onClose={() => closeTab(shownSession.key)} />}
          />
          <SessionNotice session={shownSession} resuming={actions.starting} onResume={() => { void actions.start({ mode: 'resume', resumeKey: shownSession.key }); }} />
          <div className="ms-claude__body" {...tabPanelProps('claude', shownSession.key)}>
            <SessionBody session={shownSession} active={active} resuming={actions.starting} onResume={() => { void actions.start({ mode: 'resume', resumeKey: shownSession.key }); }} />
          </div>
        </>
      ) : (
        <ClaudeEmpty project={project} starting={actions.starting} quiet={stripShown} onLocal={newLocal} onCloud={newCloud} onFix={openSettings} />
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

/** Sessions that ended because their terminal went on as another session: kept as history, opened on request. */
function historyGroup(heading: string, list: SessionView[], show: (key: SessionKey) => void): MenuEntry[] {
  if (list.length === 0) return [];
  return [
    { type: 'heading', label: heading },
    ...list.map((s): MenuEntry => ({
      label: `${shortId(s)}, ${ORIGIN_LABEL[s.origin]}, ${s.stateLabel}, went on as ${shortSessionId(s.replacedBy ?? '')}`,
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
