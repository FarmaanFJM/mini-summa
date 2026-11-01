import type { Project, SessionKey, SessionView } from '@minisumma/shared';
import { useCallback, useState } from 'react';
import { useApi, useRoute, useRuntime, useTerminals } from '../../app/runtime';
import { toast } from '../../ui';

export interface StartOptions {
  mode: 'new' | 'resume';
  resumeKey?: SessionKey;
  rootId?: string;
  /** Start in a temporary workspace of the project instead of one of its folders. */
  workspaceId?: string;
  name?: string;
}

export interface SessionActions {
  starting: boolean;
  /** Start or resume a managed session, open its tab and put the cursor in it. Returns the session, or null on failure. */
  start(options: StartOptions): Promise<SessionView | null>;
  /** Make an existing session the visible tab. */
  show(key: SessionKey, opts?: { focus?: boolean }): void;
  /** Open a session that was replaced inside its terminal, as the history it is: its tab stays, it does not move on to its successor. */
  showHistory(key: SessionKey): void;
  /** Hide a tab. The session itself keeps running. With `keepCloud`, a pane that shows the Cloud tab keeps showing it. */
  close(key: SessionKey, selectedAfter: SessionKey | null, opts?: { keepCloud?: boolean }): void;
}

export function useSessionActions(project: Project): SessionActions {
  const api = useApi();
  const route = useRoute();
  const { ui } = useRuntime();
  const terminals = useTerminals();
  const [starting, setStarting] = useState(false);

  const show = useCallback((key: SessionKey, opts?: { focus?: boolean }) => {
    ui.getState().openTab(project.id, key);
    route.selectSession(project.id, key);
    if (opts?.focus !== false) ui.getState().focusTerminal(key);
  }, [project.id, route, ui]);

  const showHistory = useCallback((key: SessionKey) => {
    ui.getState().keepHistory(key);
    show(key, { focus: false });
  }, [show, ui]);

  const start = useCallback(async (options: StartOptions): Promise<SessionView | null> => {
    setStarting(true);
    try {
      const size = terminals.suggestedSize();
      const session = await api.call('sessions.start', {
        params: { id: project.id },
        body: { mode: options.mode, resumeKey: options.resumeKey, rootId: options.rootId, workspaceId: options.workspaceId, name: options.name || undefined, cols: size.cols, rows: size.rows },
      });
      // A resumed session continues the earlier one, so its tab takes the old tab's place.
      if (options.resumeKey) ui.getState().replaceTab(project.id, options.resumeKey, session.key);
      show(session.key);
      return session;
    } catch (err) {
      toast({
        title: options.mode === 'resume' ? 'Could not resume the session' : 'Could not start a session',
        body: err instanceof Error ? err.message : undefined,
        kind: 'error',
      });
      return null;
    } finally {
      setStarting(false);
    }
  }, [api, project.id, show, terminals, ui]);

  const close = useCallback((key: SessionKey, selectedAfter: SessionKey | null, opts?: { keepCloud?: boolean }) => {
    ui.getState().closeTab(project.id, key);
    route.selectSession(project.id, selectedAfter, opts);
  }, [project.id, route, ui]);

  return { starting, start, show, showHistory, close };
}
