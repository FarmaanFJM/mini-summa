// Route helpers. Everything that navigates builds its target here so screens, notifications and tests agree.
// Query parameters carry ids (session keys contain `|` and `:`, which the router encodes for us).
// Pure module: no router import, so selectors and notification routing can be tested without the navigation stack.
import type { SessionKey } from '@minisumma/shared';

export type AppHref = { pathname: string; params?: Record<string, string> } | string;

export const go = {
  home: '/',
  activity: '/activity',
  inbox: '/inbox',
  reports: '/reports',
  settings: '/settings',
  pair: '/pair',
  project: (id: string): AppHref => ({ pathname: '/project', params: { id } }),
  session: (key: SessionKey | string): AppHref => ({ pathname: '/session', params: { key } }),
  report: (id: string): AppHref => ({ pathname: '/report', params: { id } }),
  send: (key: SessionKey | string): AppHref => ({ pathname: '/session/send', params: { key } }),
  remoteControl: (key: SessionKey | string): AppHref => ({ pathname: '/session/remote-control', params: { key } }),
  activityFocus: (activityId: string): AppHref => ({ pathname: '/activity', params: { focus: activityId } }),
} as const;
