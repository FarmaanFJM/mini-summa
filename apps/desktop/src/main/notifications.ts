// Native notifications. One live notification per tag; clicking one brings the app forward and asks the renderer to
// show what the notification was about. Electron's Notification is injected so the behaviour is testable.
import type { NativeNotification, NavigationTarget } from '@minisumma/shared';
import type { Logger } from './log.ts';

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
  icon?: string;
  /** How long to wait for the system to confirm the notification was shown. */
  confirmMs?: number;
  log: Logger;
}

export interface Notifier {
  notify(n: NativeNotification): Promise<{ shown: boolean; reason?: string }>;
  closeAll(): void;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

export function createNotifier(deps: NotifierDeps): Notifier {
  const live = new Map<string, NotificationLike>();
  const confirmMs = deps.confirmMs ?? 3000;

  return {
    async notify(n) {
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
        const settle = (result: { shown: boolean; reason?: string }): void => {
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
