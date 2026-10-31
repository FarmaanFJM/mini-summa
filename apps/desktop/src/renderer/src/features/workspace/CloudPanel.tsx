import { parseClaudeCodeUrl, teleportCommand } from '@minisumma/shared';
import type { Project } from '@minisumma/shared';
import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useNative } from '../../app/native';
import { useRouteState, useRuntime } from '../../app/runtime';
import { Button, Icon, IconButton, Spinner, tabPanelProps, toast } from '../../ui';
import { CLOUD_LINE, CLOUD_LINE_BROWSER, CLOUD_TAB_ID, cloudAddress, cloudSessionId, cloudStartUrl, cloudTarget, describeCloudView, notEmbeddedReason, sameCloudPage } from './claudeCloud';
import { useClaudeWebState } from './useClaudeWeb';
import { useNativeBounds } from './useNativeBounds';

export interface CloudPanelProps {
  project: Project;
  /** The Cloud tab is the one shown and its pane is on screen (not hidden by the other pane's focus mode, not behind another view). */
  active: boolean;
  /**
   * The project the one Claude Code view was last given to. There is a single view for the whole window, so showing another
   * project's Cloud tab loads that project's remembered page into it (the session itself lives on Anthropic's side and loses
   * nothing). Kept by the pane because this panel comes and goes with the tab.
   */
  owner: MutableRefObject<string | null>;
  /** Another main button is on screen (a report waits for its handoff), so the one here is not the emphasised one. */
  quiet: boolean;
  /**
   * Hands over the part of the tab that is above the page: toasts are placed over it, because over the page a toast would be drawn
   * under the native view, which then has to be hidden for as long as the toast is there.
   */
  onTop?: (el: HTMLElement | null) => void;
}

/** The body of the Cloud tab: Claude Code on the web in its native view, one row of controls above it, and one honest line. */
export function CloudPanel({ project, active, owner, quiet, onTop }: CloudPanelProps) {
  const native = useNative();
  const web = native.claudeWeb;
  const { route } = useRuntime();
  const remembered = useRouteState((s) => s.cloudUrlByProject[project.id]);
  const start = useRouteState((s) => s.cloudStart[project.id] === true);
  const view = useClaudeWebState(web !== undefined);
  const slot = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const latest = useRef({ project, remembered });
  latest.current = { project, remembered };

  useNativeBounds(slot, web !== undefined && active, 'claudeWeb');

  // What the view reports before it has moved to this project's page is not this project's: it is ignored until the page has been chosen.
  const gate = useRef<{ pending: boolean; leaving: string | null }>({ pending: true, leaving: null });

  // Show this project's page: the one remembered, the start page of a new session when "New cloud session" asked for it, and nothing
  // new when the view is still the project's own (what the person did in it since is what they want to come back to).
  useEffect(() => {
    if (!web || !active) return undefined;
    let cancelled = false;
    gate.current = { pending: true, leaving: owner.current === project.id ? gate.current.leaving : null };
    void (async () => {
      const state = await web.getState().catch(() => null);
      if (cancelled) return;
      const { project: shown, remembered: page } = latest.current;
      const fresh = route.getState().cloudStart[shown.id] === true;
      const wanted = fresh ? cloudStartUrl(shown) : cloudTarget(shown, page);
      const now = state?.url ?? null;
      const mine = owner.current === shown.id;
      owner.current = shown.id;
      if (!fresh && (mine || sameCloudPage(now, wanted))) { gate.current = { pending: false, leaving: gate.current.leaving }; return; }
      gate.current = { pending: false, leaving: sameCloudPage(now, wanted) ? null : now };
      try { await web.navigate(wanted); } catch { /* the view reports why it could not load */ }
      if (fresh) route.getState().finishCloudStart(shown.id);
    })();
    return () => { cancelled = true; };
    // `start` is in the list so that a "New cloud session" chosen while this tab is already showing opens its start page too.
  }, [web, active, project.id, start, route, owner]);

  // Remember the page the person is on, so the Cloud tab opens there next time. Only a page of Claude Code on the web is kept.
  useEffect(() => {
    if (!active || !view?.url || gate.current.pending) return;
    if (gate.current.leaving !== null && view.url === gate.current.leaving) return;
    gate.current.leaving = null;
    const read = parseClaudeCodeUrl(view.url);
    if (read.ok) route.getState().selectCloudUrl(project.id, read.info.url);
  }, [active, view?.url, project.id, route]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const target = cloudTarget(project, remembered);
  const shownUrl = view?.url && parseClaudeCodeUrl(view.url).ok ? view.url : target;

  const openInBrowser = () => {
    native.shell.openExternal(shownUrl).catch((err: unknown) => {
      toast({ title: 'Could not open your browser', body: err instanceof Error ? err.message : undefined, kind: 'error' });
    });
  };

  if (!web) {
    return (
      <div className="ms-claude__body ms-cloud" {...tabPanelProps('claude', CLOUD_TAB_ID)}>
        <div className="ms-cloud__plain">
          <p className="ms-cloud__why">{notEmbeddedReason(native.kind)}</p>
          <div className="ms-cloud__actions">
            <Button variant={quiet ? 'secondary' : 'primary'} icon="external" onClick={openInBrowser}>Open Claude Code on the web in your browser</Button>
          </div>
          <p className="ms-cloud__line">{CLOUD_LINE_BROWSER}</p>
        </div>
      </div>
    );
  }

  const notice = describeCloudView(view);
  const address = cloudAddress(view?.url ?? null);
  const sessionId = cloudSessionId(view?.url ?? null);
  const copyCommand = async () => {
    if (!sessionId) return;
    try {
      await native.clipboard.writeText(teleportCommand(sessionId));
      setCopied(true);
    } catch (err) {
      toast({ title: 'Could not copy', body: err instanceof Error ? err.message : undefined, kind: 'error' });
    }
  };

  return (
    <div className="ms-claude__body ms-cloud" {...tabPanelProps('claude', CLOUD_TAB_ID)}>
      <div className="ms-cloud__top" ref={onTop}>
        <div className="ms-cloud__bar">
          <IconButton label="Back" icon="arrow-left" size="sm" tooltipPlacement="top" disabled={!view?.canGoBack} onClick={() => { void web.back(); }} />
          <IconButton label="Forward" icon="arrow-right" size="sm" tooltipPlacement="top" disabled={!view?.canGoForward} onClick={() => { void web.forward(); }} />
          <IconButton label="Reload" icon="refresh" size="sm" tooltipPlacement="top" onClick={() => { void web.reload(); }} />
          <IconButton label="Open in your browser" icon="external" size="sm" tooltipPlacement="top" onClick={openInBrowser} />
          {sessionId ? (
            <IconButton label="Copy command to continue in a terminal" icon={copied ? 'check' : 'terminal'} size="sm" tooltipPlacement="top" onClick={() => { void copyCommand(); }} />
          ) : null}
          {view?.status === 'loading' ? <Spinner className="ms-cloud__busy" /> : null}
          {address ? <span className="ms-cloud__address ms-truncate" title={view?.url ?? address}>{address}</span> : null}
        </div>
        {notice ? (
          <div className="ms-notice ms-cloud__notice" data-tone={notice.tone} role="status">
            <Icon name={notice.tone === 'error' ? 'circle-alert' : 'info'} />
            <span className="ms-notice__text">{notice.text}</span>
          </div>
        ) : null}
        <p className="ms-cloud__line">{CLOUD_LINE}</p>
      </div>
      <div className="ms-cloud__view" ref={slot} data-native-slot aria-label="Embedded Claude Code view" />
    </div>
  );
}
