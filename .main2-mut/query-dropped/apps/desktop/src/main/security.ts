// Hardening for the window that shows the core's UI. The ChatGPT view has its own, stricter rules (chatgptView.ts).
import type { App, Session, WebContents } from 'electron';
import type { Logger } from './log.ts';
import { isExternalUrl, originOf } from './validation.ts';

export type MainNavDecision = 'allow' | 'external' | 'block';

/** The window may stay on the core's origin. Plain https links go to the system browser. Everything else is refused. */
export function decideMainNavigation(url: string, coreOrigin: string): MainNavDecision {
  if (originOf(url) === coreOrigin) return 'allow';
  return isExternalUrl(url) ? 'external' : 'block';
}

/** The only permission the core's page needs: writing sanitized text to the clipboard from a click. */
export function allowMainPermission(permission: string, requestingUrl: string | undefined, coreOrigin: string): boolean {
  return permission === 'clipboard-sanitized-write' && originOf(requestingUrl) === coreOrigin;
}

export function hardenMainSession(ses: Session, coreOrigin: string): void {
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(allowMainPermission(permission, (details as { requestingUrl?: string }).requestingUrl, coreOrigin));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => allowMainPermission(permission, requestingOrigin, coreOrigin));
  ses.setDevicePermissionHandler(() => false);
}

/** Every web contents the app ever creates: no <webview>, and no new windows unless something sets its own handler. */
export function hardenWebContentsCreation(app: Pick<App, 'on'>): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

export function guardMainWindowNavigation(
  contents: WebContents,
  coreOrigin: string,
  openExternal: (url: string) => void,
  log: Logger,
): void {
  const guard = (event: { preventDefault(): void }, url: string): void => {
    const decision = decideMainNavigation(url, coreOrigin);
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'external') openExternal(url);
    else log.warn('main window navigation blocked', { scheme: url.split(':')[0] });
  };
  contents.on('will-navigate', (event, url) => guard(event, url));
  contents.on('will-redirect', (event, url) => guard(event, url));
  contents.setWindowOpenHandler(({ url }) => {
    if (decideMainNavigation(url, coreOrigin) === 'external') openExternal(url);
    return { action: 'deny' };
  });
}
