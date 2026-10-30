// minisumma:// links. Pure string logic so it can be unit tested without Electron.
//
// Grammar (anything else is rejected, never guessed at):
//   minisumma://<view>[/][?project=<id>&session=<key>&report=<id>&delivery=<id>&activity=<id>&section=<name>]
// <view> is workspace | activity | reports | settings. Each query key may appear once. A link only ever asks the app to
// show something; it cannot start, send or approve anything.
import { isSessionKey } from '@minisumma/shared';
import type { NavigationTarget } from '@minisumma/shared';

export const PROTOCOL_SCHEME = 'minisumma';

const VIEWS: readonly NavigationTarget['view'][] = ['workspace', 'activity', 'reports', 'settings'];
const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const SECTION_RE = /^[a-z0-9_-]{1,40}$/;
const MAX_LINK_CHARS = 2048;

/** Query key in the link -> field of NavigationTarget. */
const PARAMS = {
  project: 'projectId',
  session: 'sessionKey',
  report: 'reportId',
  delivery: 'deliveryId',
  activity: 'activityId',
  section: 'section',
} as const;

export type ParsedLink = { ok: true; target: NavigationTarget } | { ok: false; reason: string };

const reject = (reason: string): ParsedLink => ({ ok: false, reason });

export function parseProtocolUrl(input: unknown): ParsedLink {
  if (typeof input !== 'string') return reject('The link is not text.');
  const raw = input.trim();
  if (raw === '') return reject('The link is empty.');
  if (raw.length > MAX_LINK_CHARS) return reject('The link is too long.');
  if (/[\u0000- \u007f]/.test(raw)) return reject('The link contains spaces or control characters.');
  if (!raw.toLowerCase().startsWith(`${PROTOCOL_SCHEME}://`)) return reject(`Links must start with ${PROTOCOL_SCHEME}://`);
  let url: URL;
  try { url = new URL(raw); } catch { return reject('The link is not a valid address.'); }
  if (url.protocol !== `${PROTOCOL_SCHEME}:`) return reject('Wrong scheme.');
  if (url.username || url.password || url.port) return reject('The link may not carry credentials or a port.');
  if (url.hash) return reject('The link may not carry a fragment.');
  if (url.pathname !== '' && url.pathname !== '/') return reject('The link has an unexpected path.');
  const view = url.hostname.toLowerCase() as NavigationTarget['view'];
  if (!VIEWS.includes(view)) return reject(`Unknown view "${url.hostname}".`);

  const target: NavigationTarget = { view };
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!(key in PARAMS)) return reject(`Unknown parameter "${key}".`);
    if (seen.has(key)) return reject(`Parameter "${key}" appears more than once.`);
    seen.add(key);
    const field = PARAMS[key as keyof typeof PARAMS];
    if (field === 'sessionKey') {
      if (value.length > 300 || !isSessionKey(value)) return reject('The session key is not valid.');
      target.sessionKey = value;
    } else if (field === 'section') {
      if (!SECTION_RE.test(value)) return reject('The section name is not valid.');
      target.section = value;
    } else {
      if (!ID_RE.test(value)) return reject(`The ${key} id is not valid.`);
      target[field] = value;
    }
  }
  return { ok: true, target };
}

export function formatProtocolUrl(target: NavigationTarget): string {
  const q = new URLSearchParams();
  for (const [param, field] of Object.entries(PARAMS)) {
    const value = target[field];
    if (value) q.set(param, value);
  }
  const query = q.toString();
  return `${PROTOCOL_SCHEME}://${target.view}${query ? `?${query}` : ''}`;
}

/** The first argument that looks like one of our links (how Windows hands a link to a second instance). */
export function findProtocolUrl(argv: readonly string[]): string | null {
  const prefix = `${PROTOCOL_SCHEME}:`;
  return argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(prefix)) ?? null;
}
