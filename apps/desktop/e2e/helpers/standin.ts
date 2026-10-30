// A local stand-in for chatgpt.com: an HTTPS server on loopback with a throw-away self-signed certificate.
//
// The app reaches it the way the real site would be reached: the page address is https://chatgpt.com/c/<uuid>, and
// Chromium's host-resolver rules (the MINISUMMA_TEST_HOST_RULES seam) send chatgpt.com to this server's port. The seam
// trusts the certificate for hosts that are mapped to loopback and for nothing else.
//
// Fail closed: the rules also map every OTHER host name to ~NOTFOUND (and the seam turns proxies off), so nothing the app
// does can reach a real site. Anything that nevertheless arrives here for a different Host is recorded as a stray, and the
// tests fail on it.
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
// The smoke test's certificate helper: plain JavaScript, no declarations. Typed here, once.
// @ts-ignore -- no declaration file for a .mjs helper
import { makeSelfSigned as makeCertificate } from '../../scripts/lib/selfsigned.mjs';

export const CHATGPT_HOST = 'chatgpt.com';

export interface StandInRequest {
  n: number;
  at: number;
  method: string;
  host: string;
  path: string;
  headers: IncomingHttpHeaders;
}

export interface StandIn {
  readonly port: number;
  /** The value for MINISUMMA_TEST_HOST_RULES. */
  readonly hostRules: string;
  readonly requests: readonly StandInRequest[];
  /** Requests whose Host header was not chatgpt.com: should always be empty. */
  strays(): StandInRequest[];
  /** Anything other than a GET: Mini-Summa never submits anything to ChatGPT, so this should always be empty too. */
  submissions(): StandInRequest[];
  /** An index to pass to `since`. */
  mark(): number;
  since(mark: number): StandInRequest[];
  pathsSince(mark: number): string[];
  /** Give a conversation a recognisable page title. */
  name(uuid: string, title: string): void;
  close(): Promise<void>;
}

export const conversationPath = (uuid: string): string => `/c/${uuid}`;
export const conversationUrl = (uuid: string): string => `https://${CHATGPT_HOST}${conversationPath(uuid)}`;

/** Version-4-shaped ids that are easy to tell apart in a log: aaaaaaaa-..., bbbbbbbb-..., c2c2c2c2-... */
export const uuidOf = (tag: string): string => {
  const hex = tag.toLowerCase().replace(/[^0-9a-f]/g, '').padEnd(1, 'a');
  const eight = hex.repeat(Math.ceil(8 / hex.length)).slice(0, 8);
  const four = hex.repeat(Math.ceil(4 / hex.length)).slice(0, 4);
  const twelve = hex.repeat(Math.ceil(12 / hex.length)).slice(0, 12);
  return `${eight}-${four}-4${four.slice(1)}-8${four.slice(1)}-${twelve}`;
};

const page = (title: string, path: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head>
<body>
<h1>${title}</h1>
<p id="path">${path}</p>
<form id="chat" action="#"><textarea id="composer" aria-label="Message" rows="3" cols="40"></textarea><button type="submit">Send</button></form>
<script>
  // What happened in this page, for the test to read back: Mini-Summa must never type, paste or submit into it.
  window.__standin = { events: [] };
  for (const type of ['input', 'keydown', 'paste', 'submit', 'click']) document.addEventListener(type, (e) => { window.__standin.events.push(type); if (type === 'submit') e.preventDefault(); }, true);
</script>
</body></html>`;

export async function startStandIn(): Promise<StandIn> {
  const { key, cert } = makeCertificate([CHATGPT_HOST]) as { key: string; cert: string };
  const requests: StandInRequest[] = [];
  const titles = new Map<string, string>();

  const server = https.createServer({ key, cert }, (req, res) => {
    const host = String(req.headers.host ?? '').split(':')[0].toLowerCase();
    const url = new URL(req.url ?? '/', `https://${host || CHATGPT_HOST}`);
    requests.push({ n: requests.length, at: Date.now(), method: req.method ?? 'GET', host, path: url.pathname, headers: req.headers });
    req.resume();
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (host === CHATGPT_HOST && (req.method ?? 'GET') === 'GET') {
      const conversation = /\/c\/([0-9a-f-]{36})$/i.exec(url.pathname)?.[1]?.toLowerCase();
      if (conversation) {
        res.writeHead(200, headers);
        res.end(page(titles.get(conversation) ?? `Stand-in conversation ${conversation.slice(0, 8)}`, url.pathname));
        return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, headers);
        res.end(page('Stand-in ChatGPT', '/'));
        return;
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;

  // chatgpt.com goes to this server. Every other name fails to resolve; loopback itself (the core) is left alone.
  const hostRules = [`MAP ${CHATGPT_HOST} 127.0.0.1:${port}`, 'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', 'EXCLUDE localhost'].join(', ');

  return {
    port,
    hostRules,
    requests,
    strays: () => requests.filter((r) => r.host !== CHATGPT_HOST),
    submissions: () => requests.filter((r) => r.method !== 'GET'),
    mark: () => requests.length,
    since: (mark) => requests.slice(mark),
    pathsSince: (mark) => requests.slice(mark).map((r) => r.path),
    name: (uuid, title) => { titles.set(uuid.toLowerCase(), title); },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
