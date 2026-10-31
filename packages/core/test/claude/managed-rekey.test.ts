// ManagedManagerExtras.rekey: the Claude process of a running terminal now serves another session id (/clear, /resume).
// The terminal moves to the new key; the old key stays behind as an ordinary exited record. Synthetic ids, scripted PTYs.
import { afterEach, describe, expect, it } from 'vitest';
import { makeSessionKey } from '@minisumma/shared';
import type { ManagedSessionRecord } from '../../src/contracts.ts';
import type { ManagedManager } from '../../src/contracts.ts';
import type { ManagedManagerExtras } from '../../src/claude/managed.ts';
import { CONVERSATION_ID, FakeSpawner, PROJECT_ID, RecordingSink, createHarness } from './managed-harness.ts';
import type { Harness } from './managed-harness.ts';

let h: Harness;
afterEach(async () => { await h?.cleanup(); });

const NEW = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const row = (key: string) => h.db.get<Record<string, unknown>>('SELECT * FROM managed_sessions WHERE session_key = ?', [key]);
const binding = (key: string) => h.db.get<Record<string, unknown>>('SELECT * FROM session_bindings WHERE session_key = ?', [key]);
const withRekey = (m: ManagedManager): ManagedManager & ManagedManagerExtras => m as ManagedManager & ManagedManagerExtras;
const reason = (id: string): string => `replaced:clear:${id}`;

describe('rekey moves the terminal, leaves a record behind', () => {
  it('everything that makes it the same terminal moves; the old key is an exited record that says why', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = withRekey(h.makeManager({ spawner, appRunId: 'run_A' }));
    const old = await manager.start(h.startInput({ name: 'work', remoteControl: true, conversationId: CONVERSATION_ID, rootId: 'rot_x' }));
    const pty = spawner.ptys[0];
    const sink = new RecordingSink();
    const attached = manager.attach(old.key, { cols: 100, rows: 30 }, sink);
    expect('error' in attached).toBe(false);
    pty.emitData('before the clear\r\n');
    manager.write(old.key, 'half a sentence');                       // typed at the desktop terminal, not submitted
    expect(manager.hasUnsentInput(old.key)).toBe(true);
    const changes: { key: string; status: string }[] = [];
    manager.onChange((r) => changes.push({ key: r.key, status: r.status }));

    const next = manager.rekey({ from: old.key, toSessionId: NEW.toUpperCase(), leftBehindReason: reason(NEW), prompted: false })!;
    const newKey = makeSessionKey('posix', NEW);

    // the new record is the old terminal under the new id
    expect(next).toMatchObject({
      key: newKey, env: 'posix', sessionId: NEW, projectId: PROJECT_ID, rootId: 'rot_x', cwd: h.cwd, name: 'work', mode: 'new', resumedFrom: old.key,
      remoteControl: true, status: 'running', pid: old.pid, startedAt: old.startedAt, exitedAt: null, exitReason: null, cols: 100, rows: 30,
      prompted: false, appRunId: 'run_A', conversationId: CONVERSATION_ID,
    });
    expect(manager.get(newKey)).toEqual(next);
    // the old record is history: exited, no pid, with the reason, its own prompted flag, its own binding
    expect(manager.get(old.key)).toMatchObject({ status: 'exited', pid: null, exitReason: reason(NEW), exitedAt: expect.any(String), exitCode: null, conversationId: CONVERSATION_ID });
    expect(manager.list().map((r) => [r.key, r.status]).sort()).toEqual([[old.key, 'exited'], [newKey, 'running']].sort());
    expect(row(newKey)).toMatchObject({ status: 'running', pid: old.pid, resumed_from: old.key, project_id: PROJECT_ID, name: 'work', remote_control: 1, app_run_id: 'run_A' });
    expect(row(old.key)).toMatchObject({ status: 'exited', pid: null, exit_reason: reason(NEW) });
    expect(row(newKey)!.argv_json).toBe(row(old.key)!.argv_json);                  // how the process was started is a fact about the process
    expect(binding(newKey)).toMatchObject({ source: 'managed', project_id: PROJECT_ID, conversation_id: CONVERSATION_ID });
    expect(binding(old.key)).toMatchObject({ source: 'managed', project_id: PROJECT_ID, conversation_id: CONVERSATION_ID });   // reports and deliveries stay attributed
    // listeners heard the new record first, then the old one
    expect(changes).toEqual([{ key: newKey, status: 'running' }, { key: old.key, status: 'exited' }]);

    // the terminal itself: same PTY, same scrollback, same attached sinks, same unsent-input state
    expect(manager.hasUnsentInput(newKey)).toBe(true);
    expect(manager.hasUnsentInput(old.key)).toBe(false);
    pty.emitData('after the clear\r\n');
    expect(sink.plain).toContain('before the clear');
    expect(sink.plain).toContain('after the clear');                                // the sink attached to the old key keeps receiving
    const again = manager.attach(newKey, { cols: 100, rows: 30 }, new RecordingSink());
    expect('error' in again ? '' : again.replay).toContain('before the clear');       // the scrollback is the same
    expect(manager.write(newKey, '!')).toBe(true);
    expect(manager.write(old.key, '!')).toBe(false);
    expect(await manager.typeText(newKey, 'typed by the core', { submit: false })).toBe(true);
    expect(await manager.typeText(old.key, 'no terminal here', { submit: false })).toBe(false);
    expect(await manager.sendKeys(old.key, 'approve')).toBe(false);
    expect(pty.written.join('')).toContain('typed by the core');
    manager.markPrompted(newKey);
    expect(row(newKey)).toMatchObject({ prompted: 1 });
    expect(row(old.key)).toMatchObject({ prompted: 0 });

    // the process ending is recorded on the new record, and leaves the old one alone
    pty.emitExit({ exitCode: 0, signal: null });
    expect(manager.get(newKey)).toMatchObject({ status: 'exited', exitReason: 'exited' });
    expect(manager.get(old.key)).toMatchObject({ status: 'exited', exitReason: reason(NEW) });
  });

  it('a prompt that already exists (a resume) makes the new key resumable; an existing prompted flag is never lost', async () => {
    h = createHarness();
    const manager = withRekey(h.makeManager({ spawner: new FakeSpawner() }));
    const first = await manager.start(h.startInput());
    expect(manager.rekey({ from: first.key, toSessionId: NEW, leftBehindReason: reason(NEW), prompted: true })).toMatchObject({ prompted: true });
    expect(row(makeSessionKey('posix', NEW))).toMatchObject({ prompted: 1 });
    // and back: the older key already has a row (history); it is reused, running again, and keeps what it had
    first.prompted = true;
    manager.markPrompted(first.key);
    const back = manager.rekey({ from: makeSessionKey('posix', NEW), toSessionId: first.sessionId, leftBehindReason: `replaced:resume:${first.sessionId}`, prompted: false })!;
    expect(back).toMatchObject({ key: first.key, status: 'running', prompted: true, exitReason: null, exitedAt: null, resumedFrom: makeSessionKey('posix', NEW) });
    expect(manager.get(makeSessionKey('posix', NEW))).toMatchObject({ status: 'exited', exitReason: `replaced:resume:${first.sessionId}`, prompted: true });
    expect(manager.list().filter((r) => r.status === 'running').map((r) => r.key)).toEqual([first.key]);
    expect((h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM managed_sessions'))!.n).toBe(2);   // two rows in all: nothing duplicated
  });

  it('refuses what it cannot do: no running PTY, the same id, a bad id, an id another live terminal runs, a stopped manager', async () => {
    h = createHarness();
    const spawner = new FakeSpawner();
    const manager = withRekey(h.makeManager({ spawner }));
    const a = await manager.start(h.startInput({ name: 'a' }));
    const b = await manager.start(h.startInput({ name: 'b' }));
    const req = (from: string, to: string) => ({ from: from as never, toSessionId: to, leftBehindReason: reason(to), prompted: false });
    expect(manager.rekey(req(makeSessionKey('posix', OTHER), NEW))).toBeNull();      // unknown source
    expect(manager.rekey(req(a.key, a.sessionId))).toBeNull();                       // the same id
    expect(manager.rekey(req(a.key, 'not-a-uuid'))).toBeNull();
    expect(manager.rekey(req(a.key, b.sessionId))).toBeNull();                       // another live terminal runs it
    expect(manager.get(a.key)).toMatchObject({ status: 'running' });
    expect(manager.get(b.key)).toMatchObject({ status: 'running' });
    spawner.ptys[0].emitExit({ exitCode: 0, signal: null });
    expect(manager.rekey(req(a.key, NEW))).toBeNull();                               // no PTY any more
    await manager.shutdown();
    expect(manager.rekey(req(b.key, NEW))).toBeNull();
    expect(row(makeSessionKey('posix', NEW))).toBeUndefined();                       // a refusal leaves no half-written row
  });
});

describe('restart after a re-key', () => {
  it('the record with the new id is the one that comes back disconnected and resumable; resume starts `claude --resume <new id>`', async () => {
    h = createHarness();
    const spawnerA = new FakeSpawner();
    const first = withRekey(h.makeManager({ spawner: spawnerA, appRunId: 'run_A' }));
    const old = await first.start(h.startInput({ name: 'work', conversationId: CONVERSATION_ID }));
    first.markPrompted(old.key);
    const newKey = makeSessionKey('posix', NEW);
    first.rekey({ from: old.key, toSessionId: NEW, leftBehindReason: reason(NEW), prompted: true });

    const spawnerB = new FakeSpawner();
    const second = h.makeManager({ spawner: spawnerB, appRunId: 'run_B' });
    second.init();
    expect(second.get(newKey)).toMatchObject({ status: 'disconnected', exitReason: 'app_restart', prompted: true, pid: null, name: 'work', conversationId: CONVERSATION_ID });
    expect(second.get(old.key)).toMatchObject({ status: 'exited', exitReason: reason(NEW), prompted: true });
    expect(second.list().filter((r) => r.status === 'running')).toEqual([]);

    const resumed = await second.start(h.startInput({ mode: 'resume', resumeSessionId: NEW, name: 'work' }));
    expect(resumed.key).toBe(newKey);
    const args = spawnerB.requests[0].args as string[];
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(NEW);
    expect(args).not.toContain(old.sessionId);
    expect(second.get(newKey)).toMatchObject({ status: 'running', mode: 'resume' });
    expect((h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM managed_sessions'))!.n).toBe(2);
  });
});

export type _Unused = ManagedSessionRecord;
