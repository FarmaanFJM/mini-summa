// Native notifications. One live notification per tag; clicking one brings the app forward and asks the renderer to
// show what the notification was about. Electron's Notification is injected so the behaviour is testable.
//
// A notification the core marks `suppressIfViewing` ("Claude finished") is not shown when the person is already looking at
// that very session. Only this process knows whether the window is in front; the rest of the answer is what the window left in
// the core (which project, which session tab), read through `viewing`. The rule itself is `isPersonViewing`, a pure function.
import type { NativeNotification, NativeNotifyResult, NavigationTarget, Settings } from '@minisumma/shared';
import type { Logger } from './log.ts';

/** What this process knows at the moment a notification is about to be shown. */
export interface ViewingFacts {
  /** The Mini-Summa window is visible, not minimized, and in front with the keyboard focus. Only the main process can tell. */
  windowFocused: boolean;
  /** Seconds since the keyboard or mouse was last used anywhere on this computer. null = the system cannot say, which counts as away. */
  idleSeconds: number | null;
  /** What the window left in the core about itself: the selected project and view, and each project's session tab. */
  ui: Settings['ui'];
  /** The split of the workspace: with ChatGPT maximized the Claude pane, and so the session, is not on screen. */
  layout: Pick<Settings['layout'], 'maximized'> | undefined;
}

/**
 * Without input for this long the person has probably stepped away from a window that was left in front. Then the notification
 * is shown after all: a missed "Claude finished" costs more than one toast for something that was on screen. Two minutes keeps a
 * conversation with Claude (type, watch it work, read the answer) on the quiet side.
 */
export const AWAY_AFTER_SECONDS = 120;

/**
 * Is the person looking at what `target` leads to? True only for a session of the workspace, when the window is in front, the
 * person used the computer in the last two minutes, the window shows the workspace of that project with that session's tab
 * selected, and the Claude pane is not hidden by a maximized ChatGPT pane. Every unknown means false (show it).
 *
 * The window's choices come from the core, which the window updates about 0.6 s after a change, so for that moment after
 * switching session the answer can still be the one for the session just left.
 */
export function isPersonViewing(target: NavigationTarget, facts: ViewingFacts): boolean {
  if (target.view !== 'workspace' || !target.projectId || !target.sessionKey) return false;
  if (!facts.windowFocused) return false;
  if (facts.idleSeconds === null || !(facts.idleSeconds < AWAY_AFTER_SECONDS)) return false;
  if (facts.layout?.maximized === 'chatgpt') return false;
  const route = facts.ui?.route;
  if (!route || route.view !== 'workspace' || route.projectId !== target.projectId) return false;
  return facts.ui?.perProject?.[target.projectId]?.sessionKey === target.sessionKey;
}

export interface NotificationLike {
  on(event: 'click' | 'close' | 'show' | 'failed', listener: (...args: any[]) => void): unknown;
  show(): void;
  close(): void;
}

export interface NotificationOptions {
  title: string;
  body: string;
  silent: boolean;
  urgency: 'normal' | 'critical';
  timeoutType: 'default' | 'never';
  icon?: string;
}

export interface NotifierDeps {
  create(options: NotificationOptions): NotificationLike;
  isSupported(): boolean;
  /** Reveal the window (restore, show, focus) and send the target to the renderer. */
  onClick(target: NavigationTarget): void;
  /** What the viewing rule needs, read when a notification asks for it. Without it nothing is ever held back. */
  viewing?(): ViewingFacts;
  icon?: string;
  /** How long to wait for the system to confirm the notification was shown. */
  confirmMs?: number;
  log: Logger;
}

export interface Notifier {
  notify(n: NativeNotification): Promise<NativeNotifyResult>;
  closeAll(): void;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

export function createNotifier(deps: NotifierDeps): Notifier {
  const live = new Map<string, NotificationLike>();
  const confirmMs = deps.confirmMs ?? 3000;

  return {
    async notify(n) {
      if (n.suppressIfViewing && deps.viewing) {
        let looking = false;
        try { looking = isPersonViewing(n.target, deps.viewing()); } catch (err) {
          // Not knowing is not a reason to stay silent.
          deps.log.warn('could not tell whether the person is looking at the session; showing the notification', { error: err });
        }
        if (looking) return { shown: false, suppressed: 'viewing', reason: 'The window is in front on this session, so the notification was not shown.' };
      }
      if (!deps.isSupported()) return { shown: false, reason: 'Notifications are not supported on this system.' };

      const previous = live.get(n.tag);
      if (previous) {
        live.delete(n.tag);
        try { previous.close(); } catch { /* already gone */ }
      }

      let note: NotificationLike;
      try {
        note = deps.create({
          title: clip(n.title, 200),
          body: clip(n.body, 1000),
          silent: n.silent,
          urgency: n.urgency,
          // A critical notification (a permission prompt, say) should stay until the user has seen it.
          timeoutType: n.urgency === 'critical' ? 'never' : 'default',
          ...(deps.icon ? { icon: deps.icon } : {}),
        });
      } catch (err) {
        deps.log.warn('notification could not be created', { error: err });
        return { shown: false, reason: 'The system refused to create the notification.' };
      }
      live.set(n.tag, note);

      return new Promise((resolve) => {
        let settled = false;
        const settle = (result: NativeNotifyResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!result.shown && live.get(n.tag) === note) live.delete(n.tag);
          resolve(result);
        };
        const timer = setTimeout(
          () => settle({ shown: false, reason: 'The system did not confirm that the notification was shown.' }),
          confirmMs,
        );
        note.on('show', () => settle({ shown: true }));
        note.on('failed', (_event: unknown, error?: string) => settle({ shown: false, reason: typeof error === 'string' && error ? error : 'The system could not show the notification.' }));
        note.on('click', () => { deps.onClick(n.target); });
        note.on('close', () => { if (live.get(n.tag) === note) live.delete(n.tag); });
        try { note.show(); } catch (err) {
          deps.log.warn('notification could not be shown', { error: err });
          settle({ shown: false, reason: 'The system could not show the notification.' });
        }
      });
    },

    closeAll() {
      for (const note of live.values()) { try { note.close(); } catch { /* ignore */ } }
      live.clear();
    },
  };
}
