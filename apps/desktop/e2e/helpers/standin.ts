// A local stand-in for chatgpt.com and claude.ai: one HTTPS server on loopback with a throw-away self-signed certificate.
//
// The app reaches it the way the real sites would be reached: the page address is https://chatgpt.com/c/<uuid> or
// https://claude.ai/code?repositories=..., and Chromium's host-resolver rules (the MINISUMMA_TEST_HOST_RULES seam) send both
// names to this server's port. The seam trusts the certificate for hosts that are mapped to loopback and for nothing else.
//
// A stand-in proves what Mini-Summa DOES with a page (which address it opens, that it never types or submits, how it reacts to a
// sign-in page). It proves nothing about the real sites: their markup, their sign-in and their behaviour are not reproduced.
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
export const CLAUDE_HOST = 'claude.ai';
const STAND_IN_HOSTS: readonly string[] = [CHATGPT_HOST, CLAUDE_HOST];

export interface StandInRequest {
  n: number;
  at: number;
  method: string;
  host: string;
  path: string;
  /** The query string with its question mark, or an empty string. */
  search: string;
  headers: IncomingHttpHeaders;
}

export interface StandIn {
  readonly port: number;
  /** The value for MINISUMMA_TEST_HOST_RULES. */
  readonly hostRules: string;
  readonly requests: readonly StandInRequest[];
  /** Requests whose Host header was neither chatgpt.com nor claude.ai: should always be empty. */
  strays(): StandInRequest[];
  /** Anything other than a GET: Mini-Summa never submits anything to ChatGPT or Claude, so this should always be empty too. */
  submissions(): StandInRequest[];
  /** An index to pass to `since`. */
  mark(): number;
  since(mark: number): StandInRequest[];
  pathsSince(mark: number): string[];
  /** Give a conversation a recognisable page title. */
  name(uuid: string, title: string): void;
  /** Give a ChatGPT Project (its scope id, `g-p-...`) a recognisable page title. */
  nameProject(scope: string, title: string): void;
  /** Requests made to claude.ai since the mark. */
  claudeSince(mark: number): StandInRequest[];
  /** Whether claude.ai treats the visitor as signed in (default yes). Signed out, every Claude Code page redirects to /login. */
  claudeSignedIn(signedIn: boolean): void;
  close(): Promise<void>;
}

export const conversationPath = (uuid: string): string => `/c/${uuid}`;
export const conversationUrl = (uuid: string): string => `https://${CHATGPT_HOST}${conversationPath(uuid)}`;

/** A ChatGPT Project scope id in the shape ChatGPT uses today: `g-p-` + 32 hex digits + a slug. Made up. */
export const projectScope = (tag: string, slug = 'stand-in-project'): string => `g-p-${uuidOf(tag).replace(/-/g, '').padEnd(32, '0').slice(0, 32)}-${slug}`;
export const projectUrl = (scope: string): string => `https://${CHATGPT_HOST}/g/${scope}/project`;
export const claudeCodeStandInUrl = (path = '', search = ''): string => `https://${CLAUDE_HOST}/code${path}${search}`;

/** Version-4-shaped ids that are easy to tell apart in a log: aaaaaaaa-..., bbbbbbbb-..., c2c2c2c2-... */
export const uuidOf = (tag: string): string => {
  const hex = tag.toLowerCase().replace(/[^0-9a-f]/g, '').padEnd(1, 'a');
  const eight = hex.repeat(Math.ceil(8 / hex.length)).slice(0, 8);
  const four = hex.repeat(Math.ceil(4 / hex.length)).slice(0, 4);
  const twelve = hex.repeat(Math.ceil(12 / hex.length)).slice(0, 12);
  return `${eight}-${four}-4${four.slice(1)}-8${four.slice(1)}-${twelve}`;
};

/** The Markdown the page's Copy button puts on the clipboard (a stand-in for ChatGPT's "copy a writing block"). Tests compare against it. */
export const STANDIN_MARKDOWN = '# Writing block\n\n- first point\n- second point\n\n```ts\nconst answer = 42;\n```\n';

/**
 * What a ChatGPT conversation page shows besides the composer (used by X08, the page size check). The page measures itself the way a
 * responsive site sees its width, from window.innerWidth in CSS pixels, and again on every resize (a change of the browser zoom is
 * one); it has a "writing block" with a Copy button that calls navigator.clipboard.writeText after a click, as ChatGPT's copy buttons
 * do; and it grows taller than a pane, so that it scrolls. Its state is in window.__standinPage, apart from window.__standin, the
 * recorder of what Mini-Summa must never cause, whose shape other tests compare.
 */
const WRITING_BLOCK = `<p id="viewport" role="status"></p>
<article id="block" aria-label="Writing block">
  <header><strong>Writing block</strong> <button id="copy" type="button">Copy</button></header>
  <p id="sentence">Selecting these words, scrolling past them and copying the whole block must keep working at any page size.</p>
</article>
<script>
  window.__standinPage = { instance: String(Math.random()).slice(2) + '-' + Date.now(), viewport: null, copy: null };
  const label = document.getElementById('viewport');
  const measure = () => {
    const before = window.__standinPage.viewport;
    window.__standinPage.viewport = { innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio, resizes: before ? before.resizes + 1 : 0 };
    label.textContent = 'Page width ' + window.innerWidth + ' CSS pixels';
  };
  window.addEventListener('resize', measure);
  measure();
  document.getElementById('copy').addEventListener('click', () => {
    navigator.clipboard.writeText(${JSON.stringify(STANDIN_MARKDOWN)}).then(
      () => { window.__standinPage.copy = { ok: true }; },
      (error) => { window.__standinPage.copy = { ok: false, error: String((error && error.message) || error) }; },
    );
  });
  addEventListener('DOMContentLoaded', () => {
    for (let i = 1; i <= 40; i += 1) {
      const line = document.createElement('p');
      line.textContent = 'Line ' + i + ' of the page, long enough to be a paragraph and to make the page taller than the pane.';
      document.body.append(line);
    }
  });
</script>
`;

const RECORDER = `<script>
  // What happened in this page, for the test to read back: Mini-Summa must never type, paste or submit into it.
  window.__standin = { events: [] };
  for (const type of ['input', 'keydown', 'paste', 'submit', 'click']) document.addEventListener(type, (e) => { window.__standin.events.push(type); if (type === 'submit') e.preventDefault(); }, true);
</script>`;

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const page = (title: string, path: string, extra = ''): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><link rel="icon" href="data:,"></head>
<body>
<h1>${escapeHtml(title)}</h1>
<p id="path">${escapeHtml(path)}</p>
${extra}<form id="chat" action="#"><textarea id="composer" aria-label="Message" rows="3" cols="40"></textarea><button type="submit">Send</button></form>
${RECORDER}
</body></html>`;

/** claude.ai/code: the new-session page shows the pre-filled repositories and prompt, so a test can read back what was carried in the address. */
const claudePage = (title: string, path: string, search: URLSearchParams): string => {
  const repositories = search.get('repositories') ?? search.get('repo') ?? '';
  const prompt = search.get('prompt') ?? search.get('q') ?? '';
  return page(title, path, `<p id="repositories">${escapeHtml(repositories)}</p>\n<p id="prefilled-prompt">${escapeHtml(prompt)}</p>\n`);
};

const loginPage = (): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stand-in sign in</title><link rel="icon" href="data:,"></head>
<body><h1>Sign in</h1><form action="#"><label>Email <input type="email" name="email"></label><button type="submit">Continue with email</button></form>${RECORDER}</body></html>`;

export async function startStandIn(): Promise<StandIn> {
  const { key, cert } = makeCertificate(STAND_IN_HOSTS as string[]) as { key: string; cert: string };
  const requests: StandInRequest[] = [];
  const titles = new Map<string, string>();
  const projectTitles = new Map<string, string>();
  let claudeSignedIn = true;

  const server = https.createServer({ key, cert }, (req, res) => {
    const host = String(req.headers.host ?? '').split(':')[0].toLowerCase();
    const url = new URL(req.url ?? '/', `https://${host || CHATGPT_HOST}`);
    requests.push({ n: requests.length, at: Date.now(), method: req.method ?? 'GET', host, path: url.pathname, search: url.search, headers: req.headers });
    req.resume();
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    const get = (req.method ?? 'GET') === 'GET';
    if (host === CHATGPT_HOST && get) {
      const conversation = /\/c\/([0-9a-f-]{36})$/i.exec(url.pathname)?.[1]?.toLowerCase();
      if (conversation) {
        res.writeHead(200, headers);
        res.end(page(titles.get(conversation) ?? `Stand-in conversation ${conversation.slice(0, 8)}`, url.pathname, WRITING_BLOCK));
        return;
      }
      const project = /^\/g\/(g-p-[0-9a-f]{32}[\w-]*)\/project$/i.exec(url.pathname)?.[1]?.toLowerCase();
      if (project) {
        res.writeHead(200, headers);
        res.end(page(projectTitles.get(project) ?? `Stand-in project ${project.slice(4, 12)}`, url.pathname));
        return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, headers);
        res.end(page('Stand-in ChatGPT', '/'));
        return;
      }
    }
    if (host === CLAUDE_HOST && get) {
      if (url.pathname === '/login') {
        res.writeHead(200, headers);
        res.end(loginPage());
        return;
      }
      const code = /^\/code(\/new|\/(?:session|cse)_[A-Za-z0-9]+)?$/.exec(url.pathname);
      if (code) {
        if (!claudeSignedIn) {
          res.writeHead(302, { location: `https://${CLAUDE_HOST}/login`, 'cache-control': 'no-store' });
          res.end();
          return;
        }
        const session = code[1] && code[1] !== '/new' ? code[1].slice(1) : null;
        res.writeHead(200, headers);
        res.end(claudePage(session ? `Stand-in Claude Code session ${session}` : 'Stand-in Claude Code', url.pathname, url.searchParams));
        return;
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;

  // chatgpt.com and claude.ai go to this server. Every other name fails to resolve; loopback itself (the core) is left alone.
  const hostRules = [...STAND_IN_HOSTS.map((h) => `MAP ${h} 127.0.0.1:${port}`), 'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', 'EXCLUDE localhost'].join(', ');

  return {
    port,
    hostRules,
    requests,
    strays: () => requests.filter((r) => !STAND_IN_HOSTS.includes(r.host)),
    submissions: () => requests.filter((r) => r.method !== 'GET'),
    mark: () => requests.length,
    since: (mark) => requests.slice(mark),
    pathsSince: (mark) => requests.slice(mark).map((r) => r.path),
    name: (uuid, title) => { titles.set(uuid.toLowerCase(), title); },
    nameProject: (scope, title) => { projectTitles.set(scope.toLowerCase(), title); },
    claudeSince: (mark) => requests.slice(mark).filter((r) => r.host === CLAUDE_HOST),
    claudeSignedIn: (signedIn) => { claudeSignedIn = signedIn; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
