// Integration check: the phone's real pairing, connection and send code against the REAL headless core (not a fake).
//
//   From the repository root, after `npm install` there (the core and tsx come from the root install):
//     node_modules/.bin/tsx --tsconfig apps/android/tsconfig.json apps/android/scripts/core-check.ts
//
// It starts `packages/core/src/cli.ts` on a temporary data directory, plays the desktop with the desktop token, plays the
// phone with the app's own modules (src/pairing, src/connection, src/actions) and checks what the app promises: pairing and
// its error messages, the snapshot reload, live events, removal while connected (close 4003) and while away (hello refused),
// and an unreachable PC. It does not need a phone, Android or React Native. It runs on Linux/macOS/Windows with Node 22.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiniSummaClient } from '@minisumma/shared';
import type { WebSocketCtor } from '@minisumma/shared';
import WebSocket from 'ws';
import { ConnectionManager } from '../src/connection/ConnectionManager.ts';
import type { ConnectionStatus } from '../src/connection/ConnectionManager.ts';
import { describeConnection } from '../src/connection/banner.ts';
import { PairingError, pairWithDesktop, parseScannedCode } from '../src/pairing/pairing.ts';
import { nextAttempt, sendPrompt } from '../src/actions/send.ts';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const results: { name: string; ok: boolean; detail?: string }[] = [];
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}`); } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}
function expect(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }
async function until(what: string, cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(25); }
}

async function startCore(dataDir: string): Promise<{ baseUrl: string; desktopToken: string; child: ChildProcess }> {
  const child = spawn(join(repoRoot, 'node_modules/.bin/tsx'), ['packages/core/src/cli.ts', '--data-dir', dataDir, '--port', '0', '--print-connection'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const line = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`the core did not print its address in time. stderr: ${err}`)), 30_000);
    let err = '';
    child.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
    child.stdout!.on('data', (d: Buffer) => { out += d.toString(); const nl = out.indexOf('\n'); if (nl >= 0) { clearTimeout(timer); res(out.slice(0, nl)); } });
    child.on('exit', (code) => { clearTimeout(timer); rej(new Error(`the core exited with ${code}. stderr: ${err}`)); });
  });
  return { ...(JSON.parse(line) as { baseUrl: string; desktopToken: string }), child };
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'minisumma-core-check-'));
  const core = await startCore(dataDir);
  const desktop = new MiniSummaClient({ baseUrl: core.baseUrl, token: core.desktopToken, clientName: 'core-check-desktop' });
  const wsCtor = WebSocket as unknown as WebSocketCtor;
  const managers: ConnectionManager[] = [];
  console.log(`core: ${core.baseUrl}`);

  const newOffer = () => desktop.call('pairing.createOffer', { body: { scopes: ['read', 'notify', 'prompt', 'approve'], kind: 'phone' } });
  const pair = async (name = 'Pixel 8') => {
    const offer = await newOffer();
    const payload = parseScannedCode(offer.qrPayload);
    expect(payload, 'the core produced a pairing link that the phone cannot read');
    return { offer, payload, result: await pairWithDesktop(payload, { deviceName: name }) };
  };
  const connect = async (creds: { baseUrl: string; token: string; deviceId: string; serverName: string }, extra: Partial<ConstructorParameters<typeof ConnectionManager>[0]> = {}) => {
    let revoked = 0;
    const manager = new ConnectionManager({ credentials: creds, WebSocket: wsCtor, onRevoked: () => { revoked++; }, ...extra });
    managers.push(manager);
    return { manager, revokedCount: () => revoked };
  };

  try {
    await check('pairing: the QR link from the real core is read, the address answers /health, the code is redeemed', async () => {
      const { offer, result } = await pair();
      expect(offer.qrPayload.startsWith('minisumma://pair?'), 'unexpected qrPayload');
      expect(result.attempts[0].outcome === 'ok', `first address outcome was ${result.attempts[0].outcome}`);
      expect(result.credentials.token.startsWith('msv_'), 'no device token');
      expect(result.credentials.deviceId.startsWith('dev'), 'no device id');
      expect(result.credentials.baseUrl === core.baseUrl, `stored address ${result.credentials.baseUrl}`);
      expect(result.device.platform === 'android' && result.device.name === 'Pixel 8', 'device record');
    });

    await check('pairing errors in words: a used code, a wrong code, an unknown offer', async () => {
      const first = await newOffer();
      const payload = parseScannedCode(first.qrPayload)!;
      await pairWithDesktop(payload, { deviceName: 'One' });
      const used = await pairWithDesktop(payload, { deviceName: 'Two' }).catch((e) => e as PairingError);
      expect(used instanceof PairingError && used.kind === 'code_used', `used code gave ${used instanceof PairingError ? used.kind : String(used)}`);

      const second = await newOffer();
      const wrong = await pairWithDesktop({ ...parseScannedCode(second.qrPayload)!, code: 'definitely-not-the-code' }, { deviceName: 'Three' }).catch((e) => e as PairingError);
      expect(wrong instanceof PairingError && wrong.kind === 'code_invalid', `wrong code gave ${wrong instanceof PairingError ? wrong.kind : String(wrong)}`);

      const unknown = await pairWithDesktop({ ...parseScannedCode(second.qrPayload)!, offerId: 'off_does_not_exist' }, { deviceName: 'Four' }).catch((e) => e as PairingError);
      expect(unknown instanceof PairingError && unknown.kind === 'code_invalid', `unknown offer gave ${unknown instanceof PairingError ? unknown.kind : String(unknown)}`);

      // Five wrong codes cancel the offer: the phone must say so and not suggest waiting.
      const burn = await newOffer();
      let last: PairingError | undefined;
      for (let i = 0; i < 6; i++) last = await pairWithDesktop({ ...parseScannedCode(burn.qrPayload)!, code: `wrong-code-${i}-xxxxxxxx` }, { deviceName: 'Burn' }).catch((e) => e as PairingError);
      expect(last instanceof PairingError && last.kind === 'too_many_attempts', `burned offer gave ${last?.kind}`);
      expect(last!.message.includes('cancelled'), `message was: ${last!.message}`);
    });

    await check('connect: the real core accepts the token, the snapshots load in order and the scopes are known', async () => {
      const { result } = await pair();
      const { manager } = await connect(result.credentials);
      manager.start();
      await until('connected', () => manager.getSnapshot().status === 'connected');
      const snap = manager.getSnapshot();
      expect(snap.state.loaded, 'state not loaded');
      expect(snap.device?.id === result.credentials.deviceId, 'device record is not this phone');
      expect(['read', 'notify', 'prompt', 'approve'].every((s) => snap.scopes.includes(s as never)), `scopes ${snap.scopes.join(',')}`);
      expect(snap.state.system?.apiVersion === 1, 'system info missing');
      expect(describeConnection(snap).visible === false, 'banner shown while live');
      manager.dispose();
    });

    await check('live events: a project created on the desktop appears on the phone through the stream', async () => {
      const { result } = await pair();
      const { manager } = await connect(result.credentials);
      manager.start();
      await until('connected', () => manager.getSnapshot().status === 'connected');
      const before = manager.getSnapshot().state.projects.length;
      const project = await desktop.call('projects.create', { body: { name: 'Core check project', roots: [] } });
      await until('project event', () => manager.getSnapshot().state.projects.some((p) => p.id === project.id));
      expect(manager.getSnapshot().state.projects.length === before + 1, 'project count');
      manager.dispose();
    });

    await check('send guard on the server side: a prompt for a session that does not exist is refused, not retried', async () => {
      const { result } = await pair();
      const { manager } = await connect(result.credentials);
      manager.start();
      await until('connected', () => manager.getSnapshot().status === 'connected');
      const attempt = nextAttempt(null, { sessionKey: 'win|00000000-0000-4000-8000-000000000000', text: 'hello', generation: 1 });
      const outcome = await sendPrompt(manager.call, attempt);
      expect(outcome.kind === 'refused' || outcome.kind === 'action', `unexpected ${outcome.kind}`);
      if (outcome.kind === 'action') expect(outcome.action.status !== 'executed', 'a prompt for a missing session must not execute');
      manager.dispose();
    });

    await check('a phone that lacks a scope cannot approve: the 403 is a permission error, the phone stays paired', async () => {
      const readOnlyOffer = await desktop.call('pairing.createOffer', { body: { scopes: ['read'], kind: 'phone' } });
      const res = await pairWithDesktop(parseScannedCode(readOnlyOffer.qrPayload)!, { deviceName: 'Read only' });
      const { manager, revokedCount } = await connect(res.credentials);
      manager.start();
      await until('connected', () => manager.getSnapshot().status === 'connected');
      const err = await manager.call('actions.approve', { params: { id: 'act_missing' } }).catch((e) => e as { status?: number });
      expect((err as { status?: number }).status === 403, `status ${(err as { status?: number }).status}`);
      await sleep(400); // the double check (devices.self) runs after the 403
      expect(manager.getSnapshot().status === 'connected' && revokedCount() === 0, 'a missing scope must not unpair the phone');
      manager.dispose();
    });

    await check('removal while connected: the desktop revokes the device, the stream closes with 4003, the app wipes its token', async () => {
      const { result } = await pair('To be removed');
      const { manager, revokedCount } = await connect(result.credentials);
      manager.start();
      await until('connected', () => manager.getSnapshot().status === 'connected');
      await desktop.call('devices.revoke', { params: { id: result.credentials.deviceId } });
      await until('revoked', () => manager.getSnapshot().status === 'revoked');
      expect(revokedCount() === 1, `onRevoked called ${revokedCount()} times`);
      expect(describeConnection(manager.getSnapshot()).title === 'This phone was removed in Mini-Summa. Pair again.', 'banner wording');
      manager.dispose();
    });

    await check('removal while away: the token is refused at hello (error unauthorized, close 4401) and the app wipes it', async () => {
      const { result } = await pair('Removed offline');
      await desktop.call('devices.revoke', { params: { id: result.credentials.deviceId } });
      const { manager, revokedCount } = await connect(result.credentials);
      manager.start();
      await until('revoked', () => manager.getSnapshot().status === 'revoked');
      expect(revokedCount() === 1, `onRevoked called ${revokedCount()} times`);
      manager.dispose();
    });

    await check('a PC that stops answering: reconnecting, then desktop_unreachable with the honest wording and the last update time', async () => {
      const { result } = await pair('Watcher');
      const { manager } = await connect(result.credentials, { unreachableAfterMs: 1500 });
      const seen: ConnectionStatus[] = [];
      manager.subscribe(() => { const s = manager.getSnapshot().status; if (seen[seen.length - 1] !== s) seen.push(s); });
      manager.start();
      await until('connected', () => manager.getSnapshot().status === 'connected');
      core.child.kill('SIGKILL'); // the PC goes away without saying goodbye
      await until('unreachable', () => manager.getSnapshot().status === 'desktop_unreachable', 20_000);
      const banner = describeConnection(manager.getSnapshot());
      expect(seen.includes('reconnecting'), `statuses: ${seen.join(' > ')}`);
      expect(banner.title === 'Cannot reach your PC' && banner.detail!.includes('most likely asleep or turned off'), `banner: ${banner.title} / ${banner.detail}`);
      expect(/^Last updated \d\d:\d\d$/.test(banner.lastUpdated ?? ''), `last updated: ${banner.lastUpdated}`);
      expect(manager.getSnapshot().state.loaded, 'the old data should still be there, marked as not live');
      manager.dispose();
    });
  } finally {
    for (const m of managers) m.dispose();
    core.child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed against the real core.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
