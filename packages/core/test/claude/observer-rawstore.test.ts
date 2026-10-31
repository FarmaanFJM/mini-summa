import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@minisumma/storage';
import type { Db } from '@minisumma/storage';
import type { Clock } from '../../src/contracts.ts';
import { createRawStore } from '../../src/claude/rawStore.ts';
import type { RawStore } from '../../src/claude/rawStore.ts';
import { S1, discoveryEntry, hookEntry, hookPayload, isoAt } from './helpers/observer-hook.ts';

let db: Db;
let store: RawStore;
let now = new Date('2026-03-01T10:00:00.000Z');
const clock: Clock = { now: () => now };
const dirs: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-rawstore-')); dirs.push(d); return d; };

beforeEach(() => {
  db = openDatabase(':memory:').db;
  now = new Date('2026-03-01T10:00:00.000Z');
  store = createRawStore(db, clock);
});
afterEach(() => {
  db.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const hook = (n: number, extra: Record<string, unknown> = {}) => hookEntry({ n, payload: hookPayload('Notification', S1, { notification_type: 'idle_prompt', message: `m${n}`, ...extra }) });

describe('appendRaw', () => {
  it('stores the entry and returns it with seq (the column) and ingested_at, in the library order {seq, ingested_at, ...entry}', () => {
    const e = hook(1);
    const stored = store.appendRaw(e)!;
    expect(stored.seq).toBe(1);
    expect(stored.ingested_at).toBe('2026-03-01T10:00:00.000Z');
    expect(Object.keys(stored).slice(0, 2)).toEqual(['seq', 'ingested_at']);
    expect(stored).toMatchObject({ kind: 'hook', transport: e.transport, payload: e.payload });
    expect(store.get(1)).toEqual(stored);
  });

  it('keeps seq and ingested_at out of the stored JSON: the columns are the only source of both', () => {
    store.appendRaw({ ...hook(1), seq: 99, ingested_at: 'bogus' } as never);
    const row = db.get<{ entry_json: string; seq: number; ingested_at: string }>('SELECT seq, ingested_at, entry_json FROM raw_events')!;
    expect(Object.keys(JSON.parse(row.entry_json)).sort()).toEqual(['kind', 'payload', 'transport']);
    expect(row.seq).toBe(1);
    expect(row.ingested_at).toBe('2026-03-01T10:00:00.000Z');
  });

  it('is idempotent by transport_id: the second append returns null, stores nothing and leaves no gap in seq', () => {
    expect(store.appendRaw(hook(1))).not.toBeNull();
    expect(store.appendRaw(hook(1))).toBeNull();
    expect(store.appendRaw(hook(1))).toBeNull();
    const next = store.appendRaw(hook(2))!;
    expect(next.seq).toBe(2);
    expect(store.count()).toBe(2);
  });

  it('treats receipts with different transport ids as different even when the payload is identical', () => {
    const a = hookEntry({ n: 1, tid: 'a', payload: hookPayload('Stop', S1) });
    const b = hookEntry({ n: 1, tid: 'b', payload: hookPayload('Stop', S1) });
    expect(store.appendRaw(a)).not.toBeNull();
    expect(store.appendRaw(b)).not.toBeNull();
    expect(store.count()).toBe(2);
  });

  it('stores discovery entries (no transport id) every time, and records the environment', () => {
    const d = discoveryEntry({ n: 3, env: 'wsl:Ubuntu', sessions: [] });
    expect(store.appendRaw(d)).not.toBeNull();
    expect(store.appendRaw(d)).not.toBeNull();
    expect(store.count()).toBe(2);
    expect(db.all<{ kind: string; env_id: string; transport_id: string | null }>('SELECT kind, env_id, transport_id FROM raw_events')).toEqual([
      { kind: 'discovery', env_id: 'wsl:Ubuntu', transport_id: null }, { kind: 'discovery', env_id: 'wsl:Ubuntu', transport_id: null },
    ]);
  });
});

describe('reading', () => {
  beforeEach(() => { for (let n = 1; n <= 5; n++) store.appendRaw(hook(n)); });

  it('since(seq) returns the entries after seq in ascending order, and since(0) is everything', () => {
    expect(store.since(2).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(store.since(5)).toEqual([]);
    expect(store.since(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(store.loadAll().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('since(seq, limit) reads in chunks that can be continued from the last seq', () => {
    const first = store.since(0, 2);
    const second = store.since(first[first.length - 1].seq, 2);
    const third = store.since(second[second.length - 1].seq, 2);
    expect([first, second, third].map((c) => c.map((e) => e.seq))).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('get returns null for a seq that does not exist; count and maxSeq describe the log', () => {
    expect(store.get(99)).toBeNull();
    expect(store.count()).toBe(5);
    expect(store.maxSeq()).toBe(5);
    expect(createRawStore(openDatabase(':memory:').db, clock).maxSeq()).toBe(0);
  });

  it('skips a row whose JSON is unreadable instead of failing the whole read', () => {
    db.run("UPDATE raw_events SET entry_json = '{broken' WHERE seq = 3");
    expect(store.since(0).map((e) => e.seq)).toEqual([1, 2, 4, 5]);
  });
});

describe('prune', () => {
  it('deletes entries ingested before the cutoff and reports how many; newer ones stay', () => {
    store.appendRaw(hook(1));
    store.appendRaw(hook(2));
    now = new Date('2026-03-02T10:00:00.000Z');
    store.appendRaw(hook(3));
    expect(store.prune('2026-03-01T22:00:00.000Z')).toBe(2);
    expect(store.since(0).map((e) => e.seq)).toEqual([3]);
    expect(store.prune('2026-03-01T22:00:00.000Z')).toBe(0);
  });

  it('never reuses a seq: new entries keep counting up after a prune', () => {
    store.appendRaw(hook(1));
    store.appendRaw(hook(2));
    store.prune('2099-01-01T00:00:00.000Z');
    expect(store.count()).toBe(0);
    expect(store.appendRaw(hook(3))!.seq).toBe(3);
  });
});

describe('spool ingestion (a real directory)', () => {
  const record = (tid: string, opts: { mono?: string; domain?: string | null; env?: string } = {}) => ({
    schema: 'mini-summa.spool/1',
    transport: {
      transport_id: tid, received_at: isoAt(1), wall_ms: 1, monotonic_ns: opts.mono ?? '1', capture_version: 1, hook_arg: 'Notification', handler_id: 'h1',
      env_id: opts.env ?? 'posix', clock_domain: opts.domain === undefined ? 'posix|boot:x' : opts.domain, pid: 1, ppid: 1, platform: 'linux',
      claude_project_dir: null, claude_config_dir: null, claude_code_remote: null, redactions: 0, truncations: 0, parse_error: null,
    },
    payload: hookPayload('Notification', S1, { notification_type: 'idle_prompt', message: tid }),
  });
  const put = (dir: string, name: string, value: unknown): void => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value)); };
  const tids = (): string[] => store.since(0).map((e) => (e.transport as { transport_id: string }).transport_id);

  it('orders by clock domain, then monotonic_ns inside a domain, then file name, and moves the files to done/', () => {
    const spool = path.join(tmp(), 'spool');
    put(spool, '3-B5.json', record('B5', { domain: 'B|boot:2', mono: '5' }));
    put(spool, '9-A900.json', record('A900', { domain: 'A|boot:1', mono: '900' }));
    put(spool, '1-A10.json', record('A10', { domain: 'A|boot:1', mono: '10' }));
    put(spool, 'n2.json', record('n2', { domain: null }));
    put(spool, 'n1.json', record('n1', { domain: null }));
    const res = store.ingestSpool(spool);
    expect(res).toEqual({ ingested: 5, already_ingested: 0, quarantined: 0 });
    expect(tids()).toEqual(['n1', 'n2', 'A10', 'A900', 'B5']);
    expect(store.pendingSpool(spool)).toEqual([]);
    expect(fs.readdirSync(path.join(spool, 'done')).sort()).toEqual(['1-A10.json', '3-B5.json', '9-A900.json', 'n1.json', 'n2.json']);
  });

  it('compares monotonic values as numbers, not as strings (10 comes before 9 only as text)', () => {
    const spool = path.join(tmp(), 'spool');
    put(spool, 'a.json', record('ten', { mono: '10' }));
    put(spool, 'b.json', record('nine', { mono: '9' }));
    put(spool, 'c.json', record('big', { mono: '123456789012345678901' }));
    store.ingestSpool(spool);
    expect(tids()).toEqual(['nine', 'ten', 'big']);
  });

  it('quarantines files that are not spool records and leaves temp files alone', () => {
    const spool = path.join(tmp(), 'spool');
    put(spool, 'bad.json', '{not json');
    put(spool, 'wrong.json', { schema: 'something-else', transport: {}, payload: {} });
    put(spool, '.tmp-half', '{"half":');
    put(spool, 'ok.json', record('ok'));
    expect(store.ingestSpool(spool)).toEqual({ ingested: 1, already_ingested: 0, quarantined: 2 });
    expect(fs.readdirSync(path.join(spool, 'quarantine')).sort()).toEqual(['bad.json', 'wrong.json']);
    expect(fs.existsSync(path.join(spool, '.tmp-half'))).toBe(true);
  });

  it('counts a file that comes back after a crash as already ingested and moves it again, without a second row', () => {
    const spool = path.join(tmp(), 'spool');
    put(spool, 'a.json', record('a'));
    store.ingestSpool(spool);
    fs.copyFileSync(path.join(spool, 'done', 'a.json'), path.join(spool, 'a.json'));
    expect(store.ingestSpool(spool)).toEqual({ ingested: 0, already_ingested: 1, quarantined: 0 });
    expect(store.count()).toBe(1);
    expect(store.pendingSpool(spool)).toEqual([]);
  });

  it('honours the barrier set: files outside `only` are neither read nor moved', () => {
    const spool = path.join(tmp(), 'spool');
    put(spool, 'a.json', record('a'));
    put(spool, 'b.json', record('b'));
    expect(store.ingestSpool(spool, { only: new Set(['a.json']) }).ingested).toBe(1);
    expect(tids()).toEqual(['a']);
    expect(store.pendingSpool(spool)).toEqual(['b.json']);
    expect(store.ingestSpool(spool, { only: new Set() }).ingested).toBe(0);
  });

  it('pendingSpool of a directory that does not exist is empty and does not create it', () => {
    const missing = path.join(tmp(), 'nope');
    expect(store.pendingSpool(missing)).toEqual([]);
    expect(fs.existsSync(missing)).toBe(false);
  });
});
