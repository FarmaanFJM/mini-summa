// PushProvider for Firebase Cloud Messaging (HTTP v1), using the user's OWN Firebase project.
//
// The user imports their service account JSON once. It is validated, stored at <dataDir>/secrets/fcm-service-account.json
// with mode 0600, and never logged. Sending:
//   1. sign a short-lived RS256 JWT with node:crypto (scope firebase.messaging),
//   2. exchange it at the account's token_uri for an access token (cached until 60 s before it expires),
//   3. POST one message per device to https://fcm.googleapis.com/v1/projects/<project>/messages:send.
// Messages carry only what PushPayload carries: a title, a short body and ids. No report text, tool input or paths.
//
// Test seams (production leaves them unset): overrides.pushEndpoint replaces the FCM base URL and, with it, allows an
// http token_uri; `fetch` replaces the global fetch.
import { createPrivateKey, createSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CoreBase, CoreOptions, PushPayload, PushProvider, SettingsService } from '../contracts.ts';
import { renameSyncWithRetry } from '../claude/fsRetry.ts';
import { CoreError, badRequest } from '../errors.ts';

export interface FcmDeps {
  base: Pick<CoreBase, 'dataDir' | 'clock' | 'log'>;
  settings: Pick<SettingsService, 'get' | 'update'>;
  overrides?: Pick<NonNullable<CoreOptions['overrides']>, 'pushEndpoint'>;
  fetch?: typeof fetch;
  /** Per request. Default 10 000. */
  requestTimeoutMs?: number;
}

interface ServiceAccount {
  type: 'service_account';
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
  private_key_id?: string;
}

type SendResult = { deviceId: string; result: 'sent' | 'failed' | 'invalid_token'; error?: string };

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_ENDPOINT = 'https://fcm.googleapis.com';
const MAX_JSON_CHARS = 64 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const CONCURRENCY = 5;
const FILE_NAME = 'fcm-service-account.json';
const GET_KEY_HELP = 'In the Firebase console open Project settings, then Service accounts, then choose Generate new private key, and paste the whole downloaded file.';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

/** Validates the text of a service account file. Never echoes its content: parser messages can quote the input. */
function parseServiceAccount(input: string, allowInsecureTokenUri: boolean): ServiceAccount {
  // A file saved by Windows tools may start with a byte order mark; JSON.parse rejects it.
  const text = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : input;
  if (typeof text !== 'string' || text.trim() === '') throw badRequest(`Paste the service account JSON first. ${GET_KEY_HELP}`, undefined, 'invalid_service_account');
  if (text.length > MAX_JSON_CHARS) throw badRequest(`That text is too long to be a service account key. Paste only the JSON file from Firebase. ${GET_KEY_HELP}`, undefined, 'invalid_service_account');
  let json: unknown;
  try { json = JSON.parse(text); } catch {
    throw badRequest(`That is not valid JSON. Copy the complete contents of the file without changing it. ${GET_KEY_HELP}`, undefined, 'invalid_service_account');
  }
  if (!isObject(json)) throw badRequest(`That is not a service account file. ${GET_KEY_HELP}`, undefined, 'invalid_service_account');
  if (json.type !== 'service_account') {
    throw badRequest(`This file is not a Firebase service account key (its "type" is not "service_account"). ${GET_KEY_HELP}`, undefined, 'invalid_service_account');
  }
  const field = (name: string, opts: { keepExact?: boolean } = {}): string => {
    const v = json[name];
    if (typeof v !== 'string' || v.trim() === '') throw badRequest(`The service account file has no "${name}". ${GET_KEY_HELP}`, { field: name }, 'invalid_service_account');
    return opts.keepExact ? v : v.trim();
  };
  const projectId = field('project_id');
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{2,100}$/.test(projectId)) throw badRequest('The "project_id" in this file does not look like a Firebase project id. Download a fresh key from Firebase and paste it unchanged.', { field: 'project_id' }, 'invalid_service_account');
  const clientEmail = field('client_email');
  if (!/^[^@\s]+@[^@\s]+$/.test(clientEmail)) throw badRequest('The "client_email" in this file is not an email address. Download a fresh key from Firebase and paste it unchanged.', { field: 'client_email' }, 'invalid_service_account');
  const privateKey = field('private_key', { keepExact: true });
  try {
    if (createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw new Error('not rsa');
  } catch (err) {
    const notRsa = err instanceof Error && err.message === 'not rsa';
    throw badRequest(
      notRsa
        ? 'The private key in this file is not an RSA key, and Firebase service account keys are RSA keys. Download a fresh key from Firebase and paste it unchanged.'
        : 'The private key in this file could not be read. Paste the file unchanged, including the lines that start with -----BEGIN PRIVATE KEY-----.',
      { field: 'private_key' },
      'invalid_service_account',
    );
  }
  const tokenUri = field('token_uri');
  let uri: URL | null = null;
  try { uri = new URL(tokenUri); } catch { uri = null; }
  if (!uri || (uri.protocol !== 'https:' && !(allowInsecureTokenUri && uri.protocol === 'http:'))) {
    throw badRequest('The "token_uri" in this file must be an https address (normally https://oauth2.googleapis.com/token). Download a fresh key from Firebase and paste it unchanged.', { field: 'token_uri' }, 'invalid_service_account');
  }
  const keyId = typeof json.private_key_id === 'string' ? json.private_key_id : undefined;
  return { type: 'service_account', project_id: projectId, client_email: clientEmail, private_key: privateKey, token_uri: tokenUri, ...(keyId ? { private_key_id: keyId } : {}) };
}

const clip = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}...` : t;
};

/** What a failed response says, short, with the device token masked in case Google echoes it. */
function shortError(text: string, token: string): string {
  return clip(token === '' ? text : text.split(token).join('[token]'), 160);
}

export function createFcmProvider(deps: FcmDeps): PushProvider {
  const { dataDir, clock, log } = deps.base;
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.requestTimeoutMs ?? 10_000;
  const endpoint = (deps.overrides?.pushEndpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const allowInsecure = deps.overrides?.pushEndpoint !== undefined;
  const secretsDir = path.join(dataDir, 'secrets');
  const file = path.join(secretsDir, FILE_NAME);

  let cached: { account: ServiceAccount; stamp: string } | null = null;
  let token: { value: string; expiresAtMs: number } | null = null;
  let tokenRequest: Promise<{ value: string; expiresAtMs: number }> | null = null;
  let warnedUnreadable = false;

  /** The stored account, re-read when the file changed. null when there is none or it is not usable. */
  function loadAccount(): ServiceAccount | null {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { cached = null; return null; }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (cached && cached.stamp === stamp) return cached.account;
    try {
      const account = parseServiceAccount(fs.readFileSync(file, 'utf8'), allowInsecure);
      cached = { account, stamp };
      warnedUnreadable = false;
      return account;
    } catch {
      cached = null;
      if (!warnedUnreadable) { warnedUnreadable = true; log.warn('The stored Firebase service account cannot be used. Import it again in Settings, Notifications.'); }
      return null;
    }
  }

  function syncSettings(configured: boolean): void {
    try {
      const now = deps.settings.get().mobile.push;
      const want = { provider: configured ? 'fcm' as const : 'none' as const, configured };
      if (now.provider !== want.provider || now.configured !== want.configured) deps.settings.update({ mobile: { push: want } });
    } catch (err) {
      log.warn('Could not record the push setup in the settings.', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // The file is the truth; the setting only mirrors it for the UI. Repair a mismatch left by a manual delete.
  syncSettings(loadAccount() !== null);

  // -------------------------------------------------------------------------------------------------------------
  // Access token

  function signJwt(account: ServiceAccount, nowSec: number): string {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(account.private_key_id ? { kid: account.private_key_id } : {}) }));
    const claims = b64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: account.token_uri, iat: nowSec, exp: nowSec + 3600 }));
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.private_key);
    return `${header}.${claims}.${b64url(signature)}`;
  }

  async function requestToken(account: ServiceAccount): Promise<{ value: string; expiresAtMs: number }> {
    const jwt = signJwt(account, Math.floor(clock.now().getTime() / 1000));
    let res: Response;
    try {
      res = await doFetch(account.token_uri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`Could not reach Google to sign in the service account (${networkReason(err)}). Check the internet connection.`);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let why = '';
      try {
        const body: unknown = JSON.parse(text);
        if (isObject(body) && typeof body.error === 'string') why = `: ${body.error}${typeof body.error_description === 'string' ? `, ${body.error_description}` : ''}`;
      } catch { /* body was not JSON */ }
      throw new Error(`Google refused the service account (HTTP ${res.status}${clip(why, 120)}). Check that the key was not deleted in the Firebase console, or import a new one.`);
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!isObject(body) || typeof body.access_token !== 'string' || body.access_token === '') {
      throw new Error('Google answered the sign-in without an access token. Try again, or import the service account again.');
    }
    const seconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
    return { value: body.access_token, expiresAtMs: clock.now().getTime() + seconds * 1000 };
  }

  /** A usable access token. `stale` = a token that was just rejected: replace it unless somebody already did. */
  async function accessToken(account: ServiceAccount, stale?: string): Promise<string> {
    const now = clock.now().getTime();
    if (token && now < token.expiresAtMs - TOKEN_REFRESH_MARGIN_MS && token.value !== stale) return token.value;
    tokenRequest ??= requestToken(account).then((t) => { token = t; return t; }).finally(() => { tokenRequest = null; });
    return (await tokenRequest).value;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Sending

  function networkReason(err: unknown): string {
    if (err instanceof Error) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out';
      // undici reports the system error one level down, and for a refused connection inside an AggregateError
      const cause = (err as { cause?: { code?: unknown; errors?: { code?: unknown }[]; message?: unknown } }).cause;
      if (typeof cause?.code === 'string') return cause.code;
      const inner = cause?.errors?.find((e) => typeof e?.code === 'string')?.code;
      if (typeof inner === 'string') return inner;
      if (typeof cause?.message === 'string' && /bad port/i.test(cause.message)) return 'address not allowed';
      return err.name;
    }
    return 'network error';
  }

  const dataStrings = (data: PushPayload['data']): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) if (v !== null && v !== undefined) out[k] = String(v);
    return out;
  };

  async function post(account: ServiceAccount, accessTokenValue: string, deviceToken: string, payload: PushPayload): Promise<Response> {
    return doFetch(`${endpoint}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessTokenValue}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: payload.title, body: payload.body },
          data: dataStrings(payload.data),
          android: { priority: 'high' },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** Reads an FCM error body: the FcmError code and the fields Google says were wrong. */
  function readError(text: string): { status: string | null; message: string | null; fcmCode: string | null; badFields: string[] | null } {
    let body: unknown;
    try { body = JSON.parse(text); } catch { return { status: null, message: null, fcmCode: null, badFields: null }; }
    const err = isObject(body) && isObject(body.error) ? body.error : null;
    if (!err) return { status: null, message: null, fcmCode: null, badFields: null };
    const details = Array.isArray(err.details) ? err.details.filter(isObject) : [];
    const fcm = details.find((d) => typeof d.errorCode === 'string');
    const violations = details.flatMap((d) => (Array.isArray(d.fieldViolations) ? d.fieldViolations.filter(isObject) : []));
    return {
      status: typeof err.status === 'string' ? err.status : null,
      message: typeof err.message === 'string' ? err.message : null,
      fcmCode: fcm ? String(fcm.errorCode) : null,
      badFields: violations.length > 0 ? violations.map((v) => String(v.field ?? '')) : null,
    };
  }

  async function classify(res: Response, deviceToken: string): Promise<Pick<SendResult, 'result' | 'error'>> {
    if (res.ok) return { result: 'sent' };
    const text = await res.text().catch(() => '');
    const e = readError(text);
    // A rejected token is cleared by the caller, so only call it invalid when it is the token that was wrong. An
    // INVALID_ARGUMENT that points at other fields of the message is a bug in the payload, not a dead token.
    const invalidArgument = e.fcmCode === 'INVALID_ARGUMENT' || (e.fcmCode === null && e.status === 'INVALID_ARGUMENT');
    const tokenIsWrong = invalidArgument && (e.badFields === null || e.badFields.some((f) => /token/i.test(f)));
    if (res.status === 404 || res.status === 410 || e.fcmCode === 'UNREGISTERED' || e.status === 'UNREGISTERED' || tokenIsWrong) {
      return { result: 'invalid_token', error: 'The phone is no longer registered for notifications. It will register again the next time the app opens.' };
    }
    const detail = e.message ? `: ${shortError(e.message, deviceToken)}` : '';
    if (res.status === 401 || res.status === 403) {
      return { result: 'failed', error: `Firebase refused the request (HTTP ${res.status})${detail}. Check that the Firebase Cloud Messaging API is enabled for the project and that the service account may send messages.` };
    }
    if (res.status === 429 || res.status >= 500) return { result: 'failed', error: `Firebase is busy or unavailable (HTTP ${res.status}). Mini-Summa will try again with the next notification.` };
    return { result: 'failed', error: `Firebase rejected the notification (HTTP ${res.status})${detail}.` };
  }

  async function sendOne(account: ServiceAccount, target: { deviceId: string; token: string }, payload: PushPayload): Promise<SendResult> {
    const { deviceId } = target;
    try {
      let used = await accessToken(account);
      let res = await post(account, used, target.token, payload);
      if (res.status === 401) {
        // The cached token may have been revoked early. Get a new one and try once more.
        await res.body?.cancel().catch(() => undefined);
        used = await accessToken(account, used);
        res = await post(account, used, target.token, payload);
      }
      return { deviceId, ...(await classify(res, target.token)) };
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      const own = /^(Could not reach Google|Google (refused|answered))/.test(message);
      return { deviceId, result: 'failed', error: own ? message : `Could not reach Firebase (${networkReason(err)}). Check the internet connection.` };
    }
  }

  // -------------------------------------------------------------------------------------------------------------

  return {
    name: 'fcm',

    configured: () => loadAccount() !== null,

    configureFromJson(json) {
      const account = parseServiceAccount(json, allowInsecure);
      try {
        fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
        try { fs.chmodSync(tmp, 0o600); } catch { /* Windows has no POSIX modes; the profile folder's ACL applies */ }
        renameSyncWithRetry(tmp, file);
      } catch (err) {
        log.error('Saving the Firebase service account failed.', { error: err instanceof Error ? err.message : String(err) });
        throw new CoreError(500, 'push_store_failed', `Mini-Summa could not save the service account in ${secretsDir}. Check that the folder is writable and the disk is not full, then try again.`);
      }
      cached = null;
      token = null;
      syncSettings(true);
      log.info('A Firebase service account was imported.', { firebaseProject: account.project_id });
      return { firebaseProject: account.project_id };
    },

    clear() {
      try { fs.rmSync(file, { force: true }); } catch (err) {
        throw new CoreError(500, 'push_store_failed', `Mini-Summa could not delete the stored service account at ${file}. Delete the file yourself, then try again. (${err instanceof Error ? err.message : 'unknown error'})`);
      }
      cached = null;
      token = null;
      syncSettings(false);
      log.info('The Firebase service account was removed.');
    },

    async send(targets, payload) {
      if (targets.length === 0) return [];
      const account = loadAccount();
      if (!account) {
        return targets.map((t) => ({ deviceId: t.deviceId, result: 'failed' as const, error: 'Push notifications are not set up. Import your Firebase service account in Settings, Notifications.' }));
      }
      const results: SendResult[] = new Array<SendResult>(targets.length);
      let next = 0;
      const worker = async (): Promise<void> => {
        for (let i = next++; i < targets.length; i = next++) results[i] = await sendOne(account, targets[i], payload);
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
      const count = (r: SendResult['result']): number => results.filter((x) => x.result === r).length;
      log.info('Push notifications were sent.', { sent: count('sent'), failed: count('failed'), invalidTokens: count('invalid_token') });
      return results;
    },
  };
}
