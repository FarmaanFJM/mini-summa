// FCM push provider against a local HTTP server that stands in for BOTH Google's token endpoint and FCM.
// Real Google / Firebase: NOT TESTED.
import { createVerify, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PushPayload } from '../../src/contracts.ts';
import { createFcmProvider } from '../../src/infra/push.ts';
import type { FcmDeps } from '../../src/infra/push.ts';
import { createSettingsService } from '../../src/infra/settings.ts';
import { cleanupTempDirs, expectPlainText, failure, makeBase, tempDir } from './part1-fixtures.ts';
import type { TestBase } from './part1-fixtures.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

const PROJECT = 'mini-summa-test';
const EMAIL = 'fcm-sender@mini-summa-test.iam.gserviceaccount.com';

interface Recorded { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

/** Stands in for oauth2.googleapis.com/token and fcm.googleapis.com. Behaviour per device token prefix. */
class FakeGoogle {
  readonly requests: Recorded[] = [];
  tokenRequests = 0;
  /** Access tokens that are currently valid. Remove one to make FCM answer 401 for it. */
  readonly validTokens = new Set<string>();
  tokenReply: { status: number; body: unknown } | null = null;
  jwtProblems: string[] = [];
  expiresIn = 3599;
  clockMs = () => Date.now();
  private server!: http.Server;
  url = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    if (req.url === '/token') return this.token(res, body);
    const m = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(req.url ?? '');
    if (!m) return this.json(res, 404, { error: 'unknown path' });
    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!auth || !this.validTokens.has(auth)) return this.json(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } });
    const message = (JSON.parse(body) as { message: { token: string } }).message;
    const t = message.token;
    const fcmError = (errorCode: string, extra: object = {}) => ({ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode, ...extra });
    if (t.startsWith('good')) return this.json(res, 200, { name: `projects/${m[1]}/messages/0:${Date.now()}` });
    if (t.startsWith('gone404')) return this.json(res, 404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND', details: [fcmError('UNREGISTERED')] } });
    if (t.startsWith('plain404')) return this.json(res, 404, 'Not Found');
    if (t.startsWith('gone410')) return this.json(res, 410, 'registration gone');
    if (t.startsWith('unregistered')) return this.json(res, 400, { error: { code: 400, message: 'unregistered', status: 'FAILED_PRECONDITION', details: [fcmError('UNREGISTERED')] } });
    if (t.startsWith('invalid')) return this.json(res, 400, { error: { code: 400, message: 'The registration token is not a valid FCM registration token', status: 'INVALID_ARGUMENT', details: [fcmError('INVALID_ARGUMENT')] } });
    if (t.startsWith('badpayload')) {
      return this.json(res, 400, { error: { code: 400, message: 'Invalid value at message.data', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.data[0].value', description: 'must be a string' }] }, fcmError('INVALID_ARGUMENT')] } });
    }
    if (t.startsWith('badtokenfield')) {
      return this.json(res, 400, { error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'message.token', description: 'not a valid FCM registration token' }] }, fcmError('INVALID_ARGUMENT')] } });
    }
    if (t.startsWith('statusonly')) return this.json(res, 400, { error: { code: 400, message: 'bad request', status: 'INVALID_ARGUMENT' } });
    if (t.startsWith('plain400')) return this.json(res, 400, { error: { code: 400, message: 'Something else is wrong with the request', status: 'FAILED_PRECONDITION' } });
    if (t.startsWith('denied')) return this.json(res, 403, { error: { code: 403, message: 'Firebase Cloud Messaging API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED' } });
    if (t.startsWith('busy')) return this.json(res, 429, { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
    if (t.startsWith('boom')) return this.json(res, 500, { error: { code: 500, message: 'Internal error', status: 'INTERNAL' } });
    if (t.startsWith('unavailable')) return this.json(res, 503, 'upstream connect error');
    if (t.startsWith('echo')) return this.json(res, 400, { error: { code: 400, message: `Cannot deliver to ${t} right now`, status: 'FAILED_PRECONDITION' } });
    if (t.startsWith('drop')) { req.socket.destroy(); return; }
    if (t.startsWith('slow')) { setTimeout(() => this.json(res, 200, {}), 1500); return; }
    return this.json(res, 200, {});
  }

  private token(res: http.ServerResponse, body: string): void {
    this.tokenRequests += 1;
    if (this.tokenReply) return this.json(res, this.tokenReply.status, this.tokenReply.body);
    const form = new URLSearchParams(body);
    const jwt = form.get('assertion') ?? '';
    const problems = this.checkJwt(form.get('grant_type'), jwt);
    this.jwtProblems.push(...problems);
    if (problems.length > 0) return this.json(res, 400, { error: 'invalid_grant', error_description: problems.join('; ') });
    const accessToken = `at-${this.tokenRequests}`;
    this.validTokens.add(accessToken);
    return this.json(res, 200, { access_token: accessToken, expires_in: this.expiresIn, token_type: 'Bearer' });
  }

  /** What Google would check: the grant type, an RS256 signature by the account's key, and the claims. */
  private checkJwt(grantType: string | null, jwt: string): string[] {
    const problems: string[] = [];
    if (grantType !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') problems.push(`grant_type ${grantType}`);
    const parts = jwt.split('.');
    if (parts.length !== 3) return [...problems, 'not a JWT'];
    const [h, c, s] = parts;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as Record<string, unknown>;
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as Record<string, unknown>;
    if (header.alg !== 'RS256' || header.typ !== 'JWT') problems.push('bad header');
    if (!createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))) problems.push('bad signature');
    const nowSec = Math.floor(this.clockMs() / 1000);
    if (claims.iss !== EMAIL) problems.push('bad iss');
    if (claims.scope !== 'https://www.googleapis.com/auth/firebase.messaging') problems.push('bad scope');
    if (claims.aud !== `${this.url}/token`) problems.push('bad aud');
    if (typeof claims.iat !== 'number' || Math.abs(claims.iat - nowSec) > 2) problems.push('bad iat');
    if (typeof claims.iat !== 'number' || claims.exp !== claims.iat + 3600) problems.push('bad exp');
    return problems;
  }

  messages(): { token: string; body: Record<string, unknown>; auth: string }[] {
    return this.requests.filter((r) => r.url.endsWith(':send')).map((r) => ({ token: (JSON.parse(r.body) as { message: { token: string } }).message.token, body: JSON.parse(r.body) as Record<string, unknown>, auth: String(r.headers.authorization) }));
  }
}

let google: FakeGoogle;
let base: TestBase;
let dataDir: string;
beforeAll(async () => { google = new FakeGoogle(); await google.start(); });
afterAll(async () => { await google.stop(); });
afterEach(() => { base?.close(); cleanupTempDirs(); });

/** A port on 127.0.0.1 that nothing listens on (port 1 and similar are refused by fetch itself). */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

function accountJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account', project_id: PROJECT, private_key_id: 'abc123', private_key: privateKey, client_email: EMAIL,
    client_id: '1234567890', token_uri: `${google.url}/token`, auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs', client_x509_cert_url: 'https://example.invalid/cert', ...over,
  });
}

function setup(extra: Partial<FcmDeps> = {}, opts: { endpoint?: string | null } = {}) {
  google.requests.length = 0; google.tokenRequests = 0; google.validTokens.clear(); google.tokenReply = null; google.jwtProblems = []; google.expiresIn = 3599;
  dataDir = tempDir('ms-push-');
  base = makeBase({ dataDir });
  google.clockMs = () => base.clock.now().getTime();
  const settings = createSettingsService({ base });
  const overrides = opts.endpoint === null ? undefined : { pushEndpoint: opts.endpoint ?? google.url };
  const provider = createFcmProvider({ base, settings, overrides, ...extra });
  return { provider, settings };
}

const payload = (over: Partial<PushPayload['data']> = {}): PushPayload => ({
  title: 'Report ready',
  body: 'Billing API: tests pass',
  data: { kind: 'report', projectId: 'prj_1', sessionKey: 'win|s1', reportId: 'rpt_1', activityId: 'act_1', ...over },
});
const secretFile = (): string => path.join(dataDir, 'secrets', 'fcm-service-account.json');
const everythingLogged = (): string => JSON.stringify(base.log.lines) + JSON.stringify(base.events);

describe('importing the service account', () => {
  it('stores a valid file privately and records the setup in the settings', () => {
    const { provider, settings } = setup();
    expect(provider.name).toBe('fcm');
    expect(provider.configured()).toBe(false);
    expect(provider.configureFromJson(accountJson())).toEqual({ firebaseProject: PROJECT });

    expect(provider.configured()).toBe(true);
    expect(settings.get().mobile.push).toEqual({ provider: 'fcm', configured: true });
    expect(base.eventsOf('settings.changed').at(-1)?.settings.mobile.push).toEqual({ provider: 'fcm', configured: true });
    const stored = JSON.parse(fs.readFileSync(secretFile(), 'utf8')) as Record<string, string>;
    expect(stored).toEqual({ type: 'service_account', project_id: PROJECT, client_email: EMAIL, private_key: privateKey, token_uri: `${google.url}/token`, private_key_id: 'abc123' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(secretFile()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(secretFile())).mode & 0o777).toBe(0o700);
    }
    expect(fs.readdirSync(path.dirname(secretFile()))).toEqual(['fcm-service-account.json']);
    expect(everythingLogged()).not.toContain('BEGIN PRIVATE KEY');
    expect(everythingLogged()).not.toContain(EMAIL);
    // the secret is outside anything that looks like a repository: it lives in the data directory
    expect(secretFile().startsWith(dataDir)).toBe(true);
  });

  it('keeps the private key out of the settings and out of the settings events', () => {
    const { provider, settings } = setup();
    provider.configureFromJson(accountJson());
    expect(JSON.stringify(settings.get())).not.toMatch(/PRIVATE KEY|client_email|iam\.gserviceaccount/);
    expect(JSON.stringify(base.db.all('SELECT * FROM kv'))).not.toMatch(/PRIVATE KEY|iam\.gserviceaccount/);
  });

  it('replaces an earlier import in place, keeping the file private', () => {
    const { provider } = setup();
    provider.configureFromJson(accountJson());
    expect(provider.configureFromJson(accountJson({ project_id: 'second-project' }))).toEqual({ firebaseProject: 'second-project' });
    expect(JSON.parse(fs.readFileSync(secretFile(), 'utf8')).project_id).toBe('second-project');
    expect(fs.readdirSync(path.dirname(secretFile()))).toEqual(['fcm-service-account.json']);
    if (process.platform !== 'win32') expect(fs.statSync(secretFile()).mode & 0o777).toBe(0o600);
  });

  const bad: [string, string | (() => string), RegExp][] = [
    ['nothing at all', '', /Paste the service account JSON first/],
    ['only spaces', '   \n ', /Paste the service account JSON first/],
    ['something that is not JSON', 'this is { not json', /not valid JSON/],
    ['JSON that is a list', '[1,2,3]', /not a service account file/],
    ['JSON that is a string', '"service_account"', /not a service account file/],
    ['another kind of Google key', () => accountJson({ type: 'authorized_user' }), /not a Firebase service account key/],
    ['a file without a project', () => accountJson({ project_id: undefined }), /no "project_id"/],
    ['a project id that is not one', () => accountJson({ project_id: 'a b/c' }), /does not look like a Firebase project id/],
    ['a file without an email', () => accountJson({ client_email: '' }), /no "client_email"/],
    ['an email that is not one', () => accountJson({ client_email: 'not-an-email' }), /not an email address/],
    ['a file without a private key', () => accountJson({ private_key: undefined }), /no "private_key"/],
    ['a private key that is garbage', () => accountJson({ private_key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n' }), /private key in this file could not be read/],
    ['a private key that is not RSA', () => accountJson({ private_key: ec.privateKey }), /not an RSA key/],
    ['a file without a token address', () => accountJson({ token_uri: undefined }), /no "token_uri"/],
    ['a token address that is not a URL', () => accountJson({ token_uri: 'oauth2' }), /"token_uri".*https address/],
    ['a token address that is not https', () => accountJson({ token_uri: 'ftp://oauth2.googleapis.com/token' }), /"token_uri".*https address/],
    ['more text than any key file', () => accountJson({ padding: 'x'.repeat(70_000) }), /too long/],
  ];
  for (const [name, input, message] of bad) {
    it(`refuses ${name} with a 400 that says what to do`, () => {
      const { provider, settings } = setup();
      const text = typeof input === 'function' ? input() : input;
      const err = failure(() => provider.configureFromJson(text));
      expect(err).toMatchObject({ status: 400, code: 'invalid_service_account' });
      expect(err.message).toMatch(message);
      expect(err.message).toMatch(/Firebase|Paste|Copy/);
      expectPlainText(err.message);
      // the refusal never quotes the key or the pasted text
      expect(err.message).not.toMatch(/MII[A-Za-z0-9]/);
      expect(err.message).not.toContain('nope');
      expect(err.message).not.toContain(privateKey.slice(40, 90));
      expect(provider.configured()).toBe(false);
      expect(fs.existsSync(secretFile())).toBe(false);
      expect(settings.get().mobile.push).toEqual({ provider: 'none', configured: false });
    });
  }

  it('accepts the file as Windows tools save it: with a byte order mark and surrounding blank lines', () => {
    const { provider } = setup();
    expect(provider.configureFromJson(`\uFEFF\r\n${accountJson()}\r\n\r\n`)).toEqual({ firebaseProject: PROJECT });
    expect(provider.configured()).toBe(true);
  });

  it('keeps the private key exactly as it was given (line breaks included)', () => {
    const { provider } = setup();
    provider.configureFromJson(accountJson());
    expect(JSON.parse(fs.readFileSync(secretFile(), 'utf8')).private_key).toBe(privateKey);
  });

  it('keeps the previous setup when a new import is refused', () => {
    const { provider } = setup();
    provider.configureFromJson(accountJson());
    failure(() => provider.configureFromJson(accountJson({ type: 'nope' })));
    expect(provider.configured()).toBe(true);
    expect(JSON.parse(fs.readFileSync(secretFile(), 'utf8')).project_id).toBe(PROJECT);
  });

  it('accepts an http token address only in the test configuration, never in production', () => {
    const production = setup({}, { endpoint: null });
    const err = failure(() => production.provider.configureFromJson(accountJson()));
    expect(err.message).toMatch(/"token_uri".*https address/);
    base.close();
    const testing = setup();
    expect(testing.provider.configureFromJson(accountJson())).toEqual({ firebaseProject: PROJECT });
  });

  it('accepts the https address Google really uses', () => {
    const production = setup({}, { endpoint: null });
    expect(production.provider.configureFromJson(accountJson({ token_uri: 'https://oauth2.googleapis.com/token' }))).toEqual({ firebaseProject: PROJECT });
  });
});

describe('removing and recovering the setup', () => {
  it('deletes the stored key and resets the settings', () => {
    const { provider, settings } = setup();
    provider.configureFromJson(accountJson());
    provider.clear();
    expect(provider.configured()).toBe(false);
    expect(fs.existsSync(secretFile())).toBe(false);
    expect(settings.get().mobile.push).toEqual({ provider: 'none', configured: false });
    provider.clear(); // nothing left to delete is fine
    expect(settings.get().mobile.push.configured).toBe(false);
  });

  it('notices a key file deleted behind its back', () => {
    const { provider } = setup();
    provider.configureFromJson(accountJson());
    fs.rmSync(secretFile());
    expect(provider.configured()).toBe(false);
  });

  it('picks up a key that is already there at start, and repairs a setting that disagrees with the file', () => {
    const first = setup();
    first.provider.configureFromJson(accountJson());
    // new process, same data directory and database, but the setting got lost
    base.db.run("UPDATE kv SET value_json = '{}' WHERE key = 'settings'");
    const settings = createSettingsService({ base });
    expect(settings.get().mobile.push.configured).toBe(false);
    const provider = createFcmProvider({ base, settings, overrides: { pushEndpoint: google.url } });
    expect(provider.configured()).toBe(true);
    expect(settings.get().mobile.push).toEqual({ provider: 'fcm', configured: true });
  });

  it('repairs a setting that says "configured" when the file is gone', () => {
    const first = setup();
    first.provider.configureFromJson(accountJson());
    fs.rmSync(secretFile());
    const settings = createSettingsService({ base });
    createFcmProvider({ base, settings, overrides: { pushEndpoint: google.url } });
    expect(settings.get().mobile.push).toEqual({ provider: 'none', configured: false });
  });

  it('treats a damaged key file as not configured, says so once, and never echoes it', () => {
    const first = setup();
    first.provider.configureFromJson(accountJson());
    fs.writeFileSync(secretFile(), '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nbroken');
    const settings = createSettingsService({ base });
    const provider = createFcmProvider({ base, settings, overrides: { pushEndpoint: google.url } });
    expect(provider.configured()).toBe(false);
    expect(provider.configured()).toBe(false);
    expect(base.log.lines.filter((l) => l.level === 'warn' && /cannot be used/.test(l.msg))).toHaveLength(1);
    expect(everythingLogged()).not.toContain('broken');
  });
});

describe('sending', () => {
  it('signs in with a signed JWT and sends the notification with the access token', async () => {
    const { provider } = setup();
    provider.configureFromJson(accountJson());
    const out = await provider.send([{ deviceId: 'dev_1', token: 'good-phone-token-1' }], payload());

    expect(out).toEqual([{ deviceId: 'dev_1', result: 'sent' }]);
    expect(google.jwtProblems).toEqual([]); // grant type, RS256 signature, iss, scope, aud, iat, exp all verified by the server
    expect(google.tokenRequests).toBe(1);
    const tokenRequest = google.requests[0];
    expect(tokenRequest).toMatchObject({ method: 'POST', url: '/token' });
    expect(tokenRequest.headers['content-type']).toBe('application/x-www-form-urlencoded');

    const [m] = google.messages();
    expect(m.auth).toBe('Bearer at-1');
    expect(google.requests.at(-1)).toMatchObject({ method: 'POST', url: `/v1/projects/${PROJECT}/messages:send` });
    expect(m.body).toEqual({
      message: {
        token: 'good-phone-token-1',
        notification: { title: 'Report ready', body: 'Billing API: tests pass' },
        data: { kind: 'report', projectId: 'prj_1', sessionKey: 'win|s1', reportId: 'rpt_1', activityId: 'act_1' },
        android: { priority: 'high' },
      },
    });
  });

  it('sends only strings in data and leaves out what is not there', async () => {
    const { provider } = setup();
    provider.configureFromJson(accountJson());
    await provider.send([{ deviceId: 'd', token: 'good-1' }], { title: 't', body: 'b', data: { kind: 'sessionEnded', projectId: null, activityId: 'act_9' } });
    const data = (google.messages()[0].body.message as { data: Record<string, unknown> }).data;
    expect(data).toEqual({ kind: 'sessionEnded', activityId: 'act_9' });
    expect(Object.values(data).every((v) => typeof v === 'string')).toBe(true);
  });

  it('carries nothing beyond the payload it was given', async () => {
    const { provider } = setup();
    provider.configureFromJson(accountJson());
    await provider.send([{ deviceId: 'd', token: 'good-1' }], payload());
    const raw = google.requests.at(-1)!.body;
    expect(Object.keys((JSON.parse(raw) as { message: object }).message).sort()).toEqual(['android', 'data', 'notification', 'token']);
    expect(raw).not.toMatch(/private_key|BEGIN|client_email|cwd|path|C:\\\\/);
  });

  it('answers an empty list with an empty list and does not even sign in', async () => {
    const { provider } = setup();
    provider.configureFromJson(accountJson());
    expect(await provider.send([], payload())).toEqual([]);
    expect(google.requests).toEqual([]);
  });

  it('reports every device as failed, in words, when push is not set up', async () => {
    const { provider } = setup();
    const out = await provider.send([{ deviceId: 'a', token: 'good-1' }, { deviceId: 'b', token: 'good-2' }], payload());
    expect(out.map((r) => [r.deviceId, r.result])).toEqual([['a', 'failed'], ['b', 'failed']]);
    expect(out[0].error).toMatch(/not set up.*Import your Firebase service account/);
    expectPlainText(out[0].error);
    expect(google.requests).toEqual([]);
  });

  describe('the access token', () => {
    it('is reused until 60 seconds before it expires, then renewed', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson());
      const send = () => provider.send([{ deviceId: 'd', token: 'good-1' }], payload());
      await send();
      await send();
      base.clock.advance((3599 - 60) * 1000 - 1);
      await send();
      expect(google.tokenRequests).toBe(1);
      expect(google.messages().map((m) => m.auth)).toEqual(['Bearer at-1', 'Bearer at-1', 'Bearer at-1']);
      base.clock.advance(1);
      await send();
      expect(google.tokenRequests).toBe(2);
      expect(google.messages().at(-1)?.auth).toBe('Bearer at-2');
      expect(google.jwtProblems).toEqual([]);
    });

    it('is asked for once when many devices are sent to at the same time', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson());
      const targets = Array.from({ length: 12 }, (_, i) => ({ deviceId: `dev_${i}`, token: `good-${i}` }));
      const out = await provider.send(targets, payload());
      expect(out.map((r) => r.deviceId)).toEqual(targets.map((t) => t.deviceId));
      expect(out.every((r) => r.result === 'sent')).toBe(true);
      expect(google.tokenRequests).toBe(1);
      expect(google.messages()).toHaveLength(12);
    });

    it('is thrown away when FCM refuses it, and the message is tried once more with a new one', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson());
      await provider.send([{ deviceId: 'd', token: 'good-1' }], payload());
      google.validTokens.clear(); // revoked early on Google's side
      const out = await provider.send([{ deviceId: 'd', token: 'good-1' }], payload());
      expect(out).toEqual([{ deviceId: 'd', result: 'sent' }]);
      expect(google.tokenRequests).toBe(2);
      expect(google.messages().map((m) => m.auth)).toEqual(['Bearer at-1', 'Bearer at-1', 'Bearer at-2']);
    });

    it('is not retried for ever: a second 401 is a failure with advice', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson());
      google.tokenReply = { status: 200, body: { access_token: 'never-valid', expires_in: 3600 } };
      const out = await provider.send([{ deviceId: 'd', token: 'good-1' }], payload());
      expect(out[0].result).toBe('failed');
      expect(out[0].error).toMatch(/refused the request \(HTTP 401\)/);
      expect(google.tokenRequests).toBe(2);
      expect(google.messages()).toHaveLength(2);
    });

    it('is forgotten when a different service account is imported', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson());
      await provider.send([{ deviceId: 'd', token: 'good-1' }], payload());
      provider.configureFromJson(accountJson());
      await provider.send([{ deviceId: 'd', token: 'good-1' }], payload());
      expect(google.tokenRequests).toBe(2);
    });

    it('fails every device with the reason when Google refuses to sign the service account in', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson());
      google.tokenReply = { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } };
      const out = await provider.send([{ deviceId: 'a', token: 'good-1' }, { deviceId: 'b', token: 'good-2' }], payload());
      for (const r of out) {
        expect(r.result).toBe('failed');
        expect(r.error).toMatch(/Google refused the service account \(HTTP 400: invalid_grant, Invalid JWT Signature\.\)/);
        expect(r.error).toMatch(/import a new one/);
        expectPlainText(r.error);
      }
      expect(google.messages()).toEqual([]);
      // and a later success works again
      google.tokenReply = null;
      expect((await provider.send([{ deviceId: 'a', token: 'good-1' }], payload()))[0].result).toBe('sent');
    });

    it('fails with a clear message when the answer has no access token', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson());
      google.tokenReply = { status: 200, body: { token_type: 'Bearer' } };
      expect((await provider.send([{ deviceId: 'a', token: 'good-1' }], payload()))[0].error).toMatch(/without an access token/);
    });
  });

  describe('what FCM answers', () => {
    const cases: [string, string, 'sent' | 'failed' | 'invalid_token', RegExp | null][] = [
      ['200', 'good-1', 'sent', null],
      ['404 NOT_FOUND with UNREGISTERED', 'gone404-1', 'invalid_token', /no longer registered/],
      ['404 with nothing but text', 'plain404-1', 'invalid_token', /no longer registered/],
      ['410', 'gone410-1', 'invalid_token', /no longer registered/],
      ['errorCode UNREGISTERED', 'unregistered-1', 'invalid_token', /no longer registered/],
      ['errorCode INVALID_ARGUMENT', 'invalid-1', 'invalid_token', /no longer registered/],
      ['INVALID_ARGUMENT that names the token field', 'badtokenfield-1', 'invalid_token', /no longer registered/],
      ['a bare INVALID_ARGUMENT status without details', 'statusonly-1', 'invalid_token', /no longer registered/],
      ['INVALID_ARGUMENT about other fields (a bug in the message, not a dead token)', 'badpayload-1', 'failed', /rejected the notification \(HTTP 400\)/],
      ['a 400 with nothing about tokens', 'plain400-1', 'failed', /rejected the notification \(HTTP 400\): Something else is wrong/],
      ['403', 'denied-1', 'failed', /refused the request \(HTTP 403\).*Firebase Cloud Messaging API has not been used.*API is enabled/],
      ['429', 'busy-1', 'failed', /busy or unavailable \(HTTP 429\)/],
      ['500', 'boom-1', 'failed', /busy or unavailable \(HTTP 500\)/],
      ['503 with a plain-text body', 'unavailable-1', 'failed', /busy or unavailable \(HTTP 503\)/],
    ];
    for (const [name, token, result, error] of cases) {
      it(`maps ${name} to ${result}`, async () => {
        const { provider } = setup();
        provider.configureFromJson(accountJson());
        const [r] = await provider.send([{ deviceId: 'dev_x', token }], payload());
        expect(r.deviceId).toBe('dev_x');
        expect(r.result).toBe(result);
        if (error) { expect(r.error).toMatch(error); expectPlainText(r.error); } else expect(r.error).toBeUndefined();
        expect(r.error ?? '').not.toContain(token);
      });
    }

    it('answers each device on its own, in the order asked', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson());
      const targets = [
        { deviceId: 'a', token: 'good-1' }, { deviceId: 'b', token: 'gone404-2' }, { deviceId: 'c', token: 'boom-3' },
        { deviceId: 'd', token: 'good-4' }, { deviceId: 'e', token: 'invalid-5' }, { deviceId: 'f', token: 'good-6' },
        { deviceId: 'g', token: 'denied-7' },
      ];
      const out = await provider.send(targets, payload());
      expect(out.map((r) => `${r.deviceId}:${r.result}`)).toEqual(['a:sent', 'b:invalid_token', 'c:failed', 'd:sent', 'e:invalid_token', 'f:sent', 'g:failed']);
    });

    it('masks a device token that Google repeats in its error text', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson());
      const token = 'echo-this-secret-device-token';
      const [r] = await provider.send([{ deviceId: 'a', token }], payload());
      expect(r.result).toBe('failed');
      expect(r.error).toContain('[token]');
      expect(r.error).not.toContain(token);
    });

    it('keeps long error texts short', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson());
      // the fake echoes the whole device token in its error message, so a very long token makes a very long message
      const [r] = await provider.send([{ deviceId: 'a', token: `echo-${'y'.repeat(2000)}` }], payload());
      expect(r.result).toBe('failed');
      expect((r.error ?? '').length).toBeLessThan(400);
    });
  });

  describe('when the network misbehaves', () => {
    it('reports a connection that was dropped as a failure, in words', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson());
      const [r] = await provider.send([{ deviceId: 'a', token: 'drop-1' }], payload());
      expect(r).toMatchObject({ deviceId: 'a', result: 'failed' });
      expect(r.error).toMatch(/Could not reach Firebase/);
      expect(r.error).toMatch(/internet connection/);
    });

    it('reports a server that is not there', async () => {
      const { provider } = setup({}, { endpoint: `http://127.0.0.1:${await closedPort()}` });
      provider.configureFromJson(accountJson());
      const [r] = await provider.send([{ deviceId: 'a', token: 'good-1' }], payload());
      expect(r.result).toBe('failed');
      expect(r.error).toMatch(/Could not reach Firebase \(ECONNREFUSED\)/);
    });

    it('reports an unreachable sign-in server too', async () => {
      const { provider } = setup();
      provider.configureFromJson(accountJson({ token_uri: `http://127.0.0.1:${await closedPort()}/token` }));
      const [r] = await provider.send([{ deviceId: 'a', token: 'good-1' }], payload());
      expect(r.result).toBe('failed');
      expect(r.error).toMatch(/Could not reach Google to sign in the service account \(ECONNREFUSED\)/);
    });

    it('gives up on a request that takes too long', async () => {
      const { provider } = setup({ requestTimeoutMs: 250 });
      provider.configureFromJson(accountJson());
      const started = Date.now();
      const [r] = await provider.send([{ deviceId: 'a', token: 'slow-1' }], payload());
      expect(Date.now() - started).toBeLessThan(1400);
      expect(r.result).toBe('failed');
      expect(r.error).toMatch(/timed out/);
    });
  });

  describe('against the real addresses (no network is used)', () => {
    it('signs in at the account\'s token address and posts to fcm.googleapis.com', async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init: init ?? {} });
        return url.includes('oauth2')
          ? new Response(JSON.stringify({ access_token: 'at-prod', expires_in: 3600 }), { status: 200 })
          : new Response(JSON.stringify({ name: 'projects/x/messages/1' }), { status: 200 });
      }) as unknown as typeof fetch;
      const { provider } = setup({ fetch: fakeFetch }, { endpoint: null });
      provider.configureFromJson(accountJson({ token_uri: 'https://oauth2.googleapis.com/token' }));
      const [r] = await provider.send([{ deviceId: 'a', token: 'phone-token-1' }], payload());
      expect(r.result).toBe('sent');
      expect(calls.map((c) => c.url)).toEqual(['https://oauth2.googleapis.com/token', `https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`]);
      expect((calls[1].init.headers as Record<string, string>).authorization).toBe('Bearer at-prod');
    });

    it('encodes the project id in the address', async () => {
      const urls: string[] = [];
      const fakeFetch = vi.fn(async (input: string | URL | Request) => {
        urls.push(String(input));
        return String(input).includes('oauth2') ? new Response(JSON.stringify({ access_token: 'x', expires_in: 3600 })) : new Response('{}');
      }) as unknown as typeof fetch;
      const { provider } = setup({ fetch: fakeFetch }, { endpoint: null });
      provider.configureFromJson(accountJson({ project_id: 'example.com:my-project', token_uri: 'https://oauth2.googleapis.com/token' }));
      await provider.send([{ deviceId: 'a', token: 'phone-token-1' }], payload());
      expect(urls[1]).toBe('https://fcm.googleapis.com/v1/projects/example.com%3Amy-project/messages:send');
    });
  });

  it('never writes a device token, an access token, a JWT or the private key to the log or the event stream', async () => {
    const { provider } = setup();
    provider.configureFromJson(accountJson());
    await provider.send(
      [{ deviceId: 'a', token: 'good-device-secret-AAA' }, { deviceId: 'b', token: 'gone404-device-secret-BBB' }, { deviceId: 'c', token: 'boom-device-secret-CCC' }, { deviceId: 'd', token: 'drop-device-secret-DDD' }],
      payload(),
    );
    google.tokenReply = { status: 400, body: { error: 'invalid_grant' } };
    base.clock.advance(7200_000);
    await provider.send([{ deviceId: 'e', token: 'good-device-secret-EEE' }], payload());
    const logged = everythingLogged();
    for (const secret of ['device-secret', 'at-1', 'BEGIN PRIVATE KEY', 'eyJ', EMAIL]) expect(logged, secret).not.toContain(secret);
    // what it does log is counts and device ids only
    expect(base.log.lines.filter((l) => /were sent/.test(l.msg)).map((l) => l.data)).toContainEqual({ sent: 1, failed: 2, invalidTokens: 1 });
  });
});
