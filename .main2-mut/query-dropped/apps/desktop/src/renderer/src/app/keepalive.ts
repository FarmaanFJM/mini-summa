// A write that survives the page. As the window closes, a request made with the usual client is cancelled with the page; a fetch with
// `keepalive` is carried on by the browser. It is used for one thing only: the last change to what the window remembers (uiSync.ts).
import { API_PREFIX, routes } from '@minisumma/shared';
import type { UiPrefsPatch } from '@minisumma/shared';

export interface Connection { baseUrl: string; token: string }

/**
 * Returns a function that sends `{ ui }` to the core's settings route with `keepalive`. The address and token are asked for once, up
 * front, because nothing can be awaited while the page is closing. Until they are known the function does nothing.
 */
export function keepaliveSender(connection: () => Promise<Connection>, fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args)): (body: { ui: UiPrefsPatch }) => void {
  let known: Connection | null = null;
  connection().then((c) => { known = c; }, () => { /* the window is not connected to a core: there is nothing to send to */ });
  return (body) => {
    if (!known) return;
    const url = `${known.baseUrl.replace(/\/+$/, '')}${API_PREFIX}${routes['settings.update'].path}`;
    try {
      fetchImpl(url, {
        method: routes['settings.update'].method,
        keepalive: true,
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${known.token}` },
        body: JSON.stringify(body),
      }).catch(() => { /* the page is going away; the next start sends it again from its own copy */ });
    } catch { /* a request that cannot even be made */ }
  };
}
