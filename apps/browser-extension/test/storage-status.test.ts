import { describe, expect, it } from 'vitest';
import { DEFAULT_CORE_URL, normalizeCoreUrl, redeemUrlOf, wsUrlOf } from '../src/core-address.ts';
import { describeStatus } from '../src/status.ts';
import type { ConnectionStatus } from '../src/status.ts';
import { clearPairing, loadState, markRevoked, savePairing, saveCoreUrl, toPublicState } from '../src/storage.ts';
import { MemoryArea } from './fake-socket.ts';
import { EM_DASH } from './em-dash.ts';

describe('normalizeCoreUrl', () => {
  const accepted: [string, string][] = [
    ['http://127.0.0.1:47811', 'http://127.0.0.1:47811'],
    ['  http://127.0.0.1:47811/  ', 'http://127.0.0.1:47811'],
    ['127.0.0.1:47811', 'http://127.0.0.1:47811'],
    ['localhost:5000', 'http://localhost:5000'],
    ['HTTP://LOCALHOST:5000/some/path?x=1#y', 'http://localhost:5000'],
    ['http://127.0.0.1', 'http://127.0.0.1'],
  ];
  for (const [input, url] of accepted) it(`accepts ${JSON.stringify(input)}`, () => expect(normalizeCoreUrl(input)).toEqual({ ok: true, url }));

  const refused = [
    '', '   ', 'https://127.0.0.1:47811', 'https://localhost', 'http://example.com', 'http://127.0.0.1.evil.com', 'http://localhost.evil.com:80',
    'http://192.168.1.5:47811', 'http://[::1]:47811', 'http://user:pw@127.0.0.1:47811', 'http://127.0.0.1@evil.com', 'ftp://127.0.0.1', 'javascript:alert(1)',
    'http://my-pc.tail1234.ts.net', 'not a url at all', 'http://127.0.0.1:99999',
  ];
  for (const input of refused) {
    it(`refuses ${JSON.stringify(input)} with a plain sentence`, () => {
      const r = normalizeCoreUrl(input);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.message.length).toBeGreaterThan(10);
    });
  }

  it('builds the WebSocket and redeem endpoints', () => {
    expect(wsUrlOf('http://127.0.0.1:47811')).toBe('ws://127.0.0.1:47811/ws');
    expect(wsUrlOf('http://localhost:80/')).toBe('ws://localhost:80/ws');
    expect(redeemUrlOf('http://127.0.0.1:47811/')).toBe('http://127.0.0.1:47811/api/v1/pairing/redeem');
  });
});

describe('stored state', () => {
  const record = { coreUrl: 'http://localhost:5000', token: 'tok', deviceId: 'dev-1', deviceName: 'Chrome on Windows', pairedAt: 1234 };

  it('starts empty with the default address', async () => {
    expect(await loadState(new MemoryArea())).toEqual({ coreUrl: DEFAULT_CORE_URL, token: null, deviceId: null, deviceName: null, pairedAt: null, revokedAt: null });
  });

  it('ignores stored values of the wrong type or an address this computer cannot use', async () => {
    const area = new MemoryArea();
    await area.set({ coreUrl: 'https://evil.example', token: 42, deviceName: ['x'], pairedAt: 'yesterday', revokedAt: NaN });
    expect(await loadState(area)).toEqual({ coreUrl: DEFAULT_CORE_URL, token: null, deviceId: null, deviceName: null, pairedAt: null, revokedAt: null });
  });

  it('saves a pairing and forgets an earlier revocation', async () => {
    const area = new MemoryArea();
    await markRevoked(area, 99);
    await savePairing(area, record);
    expect(await loadState(area)).toEqual({ ...record, revokedAt: null });
  });

  it('unpairing keeps the address and removes everything else', async () => {
    const area = new MemoryArea();
    await savePairing(area, record);
    await clearPairing(area);
    expect(await loadState(area)).toEqual({ coreUrl: 'http://localhost:5000', token: null, deviceId: null, deviceName: null, pairedAt: null, revokedAt: null });
  });

  it('a revocation drops the token and remembers why', async () => {
    const area = new MemoryArea();
    await savePairing(area, record);
    await markRevoked(area, 777);
    expect(await loadState(area)).toEqual({ coreUrl: 'http://localhost:5000', token: null, deviceId: null, deviceName: null, pairedAt: null, revokedAt: 777 });
  });

  it('saveCoreUrl changes only the address', async () => {
    const area = new MemoryArea();
    await savePairing(area, record);
    await saveCoreUrl(area, 'http://127.0.0.1:6000');
    expect(await loadState(area)).toMatchObject({ coreUrl: 'http://127.0.0.1:6000', token: 'tok' });
  });

  it('the public state that pages see never contains the token', async () => {
    const area = new MemoryArea();
    await savePairing(area, record);
    const pub = toPublicState(await loadState(area));
    expect(pub.paired).toBe(true);
    expect(Object.keys(pub)).not.toContain('token');
    expect(JSON.stringify(pub)).not.toContain('tok"');
  });
});

describe('describeStatus', () => {
  const base = { since: 0, coreUrl: DEFAULT_CORE_URL };
  const all: ConnectionStatus[] = [
    { state: 'not_paired', ...base },
    { state: 'revoked', ...base },
    { state: 'connecting', ...base, attempt: 1 },
    { state: 'connected', ...base, scopes: ['extension'], canAnswer: true },
    { state: 'connected', ...base, scopes: ['read'], canAnswer: false },
    { state: 'unreachable', ...base, attempt: 3, retryAt: 8_000, detail: null },
  ];

  it('has a sentence for every state, and none contains an em dash', () => {
    for (const status of all) {
      const { headline, detail } = describeStatus(status, 1_000);
      expect(headline.length).toBeGreaterThan(3);
      expect(detail.length).toBeGreaterThan(3);
      expect(`${headline} ${detail}`).not.toContain(EM_DASH);
    }
  });

  it('uses the required wording for an unpaired browser', () => {
    expect(describeStatus({ state: 'revoked', ...base }, 0).headline).toBe('This browser was unpaired in Mini-Summa');
    expect(describeStatus({ state: 'not_paired', ...base }, 0).headline).toBe('Not paired');
    expect(describeStatus({ state: 'connected', ...base, scopes: ['extension'], canAnswer: true }, 0).headline).toBe('Connected');
    expect(describeStatus({ state: 'connecting', ...base, attempt: 1 }, 0).headline).toBe('Connecting');
  });

  it('counts down to the next attempt and names the address', () => {
    const status: ConnectionStatus = { state: 'unreachable', ...base, attempt: 2, retryAt: 10_000, detail: 'The connection to Mini-Summa was closed.' };
    expect(describeStatus(status, 6_500).detail).toBe('The connection to Mini-Summa was closed. Is the app running? Trying http://127.0.0.1:47811 again in 4 s.');
    expect(describeStatus(status, 99_000).detail).toContain('again in 0 s');
    expect(describeStatus(status, 0).headline).toBe('Mini-Summa is not reachable');
  });

  it('warns when the pairing cannot answer browser requests', () => {
    const text = describeStatus({ state: 'connected', ...base, scopes: ['read'], canAnswer: false }, 0);
    expect(text.headline).toMatch(/not allowed to answer/);
    expect(text.detail).toMatch(/Create a new code/);
  });
});
