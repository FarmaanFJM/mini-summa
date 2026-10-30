// How long "Claude finished" takes inside Mini-Summa, with the poll interval the product ships with (no override).
//
// The clock starts when the hook script has put its record into the spool directory (the atomic rename: the file is listed from then
// on) and stops twice: when the notification record exists (the bus event `notification.added`), and when the desktop is asked to
// show it (the call to NativeBridge.notify). What happens before the clock starts (Claude Code starting the hook process, the
// script's own run) and after it stops (Windows showing the toast) is not in these numbers.
//
// The real parts are the hook script, the spool, the ingestion poll, the reducer, the orchestrator and the notification service. The
// model is the fake Claude CLI and the desktop is a recording fake. This runs on Linux; Windows is slower in the parts around
// the clock (a hook starts a process through PowerShell there), and nothing in this file says how much.
//
//   MS_LATENCY_SAMPLES=30 npx vitest run --root packages/core test/integration/notification-latency.test.ts   (a longer run for the docs)
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { directive, readHookRuns } from '../../src/testing/fake-claude/index.ts';
import { cleanup, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

const SAMPLES = Math.max(1, Number(process.env.MS_LATENCY_SAMPLES ?? 5));
/** The promise: with the default poll interval, a finished turn is on its way to the person within this many milliseconds. */
const BUDGET_MS = 2000;

let h: Harness | null = null;
afterEach(async () => { if (h) { await h.stop().catch(() => {}); cleanup(h); h = null; } });

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const median = (xs: number[]) => { const s = sorted(xs); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const ms = (x: number) => Math.round(x);
const stats = (xs: number[]) => `min ${ms(Math.min(...xs))}, median ${ms(median(xs))}, max ${ms(Math.max(...xs))}`;

describe('latency of "Claude finished"', () => {
  it(`reaches the desktop within ${BUDGET_MS / 1000} s of the hook writing its file, with the default poll interval`, async () => {
    // No spoolPollMs override: the harness would otherwise poll every 60 ms, which says nothing about the product.
    h = await startHarness({ core: { overrides: { spoolPollMs: undefined } } });
    const a = await h.project('GitManager');
    const session = await h.start(a.project.id);
    const layout = await h.core.services.environments.layout('posix');

    // When each spool file first showed up, to a millisecond or two (listing the directory is far finer than the 700 ms poll).
    const listed = new Map<string, number>();
    const watcher = setInterval(() => {
      let names: string[];
      try { names = fs.readdirSync(layout.spoolDirHost); } catch { return; }
      const now = performance.now();
      for (const name of names) if (name.endsWith('.json') && !listed.has(name)) listed.set(name, now);
    }, 1);

    let notifiedAt: number | null = null;
    let recordAt: number | null = null;
    const original = h.native.notify.bind(h.native);
    h.native.notify = async (n) => { notifiedAt ??= performance.now(); return original(n); };
    const off = h.core.base.bus.subscribe((_seq, event) => { if (event.type === 'notification.added') recordAt ??= performance.now(); });

    const stopFile = (): string | null => {
      const row = h!.core.base.db.get<{ transport_id: string }>(
        "SELECT transport_id FROM raw_events WHERE json_extract(entry_json, '$.payload.hook_event_name') = 'Stop' ORDER BY seq DESC LIMIT 1",
      );
      return row ? [...listed.keys()].find((name) => name.includes(row.transport_id)) ?? null : null;
    };

    const toRecord: number[] = [];
    const toNative: number[] = [];
    let typed = 0;
    try {
      for (let i = 1; toRecord.length < SAMPLES && i <= SAMPLES + 3; i++) {
        notifiedAt = null;
        recordAt = null;
        typed = i;
        await h.type(session.key, `question number ${i}`);
        await h.waitFor(`notification ${i}`, () => notifiedAt !== null && recordAt !== null, 15_000);
        const file = stopFile();
        const wrote = file ? listed.get(file) : undefined;
        if (wrote === undefined) continue; // the core took the file in the same millisecond it appeared: no start time, so no sample
        toNative.push(notifiedAt! - wrote);
        toRecord.push(recordAt! - wrote);
        // Let the turn settle, and wait a random while: every turn takes about as long as the one before, so without this each Stop would
        // land at the same moment of the 700 ms poll cycle and the samples would all read the same. A person's turns end at any moment.
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 700));
      }
    } finally {
      clearInterval(watcher);
      off();
    }

    const hookMs = readHookRuns(h.stateDir, session.sessionId).map((r) => r.ms);
    const report = [
      `latency, ${toRecord.length} turns, default poll (700 ms), spool file listed -> ...`,
      `  ... the notification record exists (ms): ${stats(toRecord)}`,
      `  ... the desktop is asked to show it (ms): ${stats(toNative)}`,
      `  hook command, spawn to exit on this Linux sandbox, ${hookMs.length} runs (ms): ${stats(hookMs)}`,
    ].join('\n');
    console.log(report);

    expect(toRecord.length).toBeGreaterThanOrEqual(Math.min(SAMPLES, 3));
    for (const t of [...toRecord, ...toNative]) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t, report).toBeLessThan(BUDGET_MS);
    }
    // One notification per turn: polling twice, or a rebuild, never made a second one.
    await new Promise((r) => setTimeout(r, 900)); // longer than one poll
    const finished = h.native.notifications.filter((n) => n.title === 'GitManager: Claude finished');
    expect(finished).toHaveLength(typed);
    expect(new Set(finished.map((n) => n.tag)).size).toBe(typed);
  }, 120_000);

  it('a report takes the same path and the same time: the report notification is not slower than "finished"', async () => {
    h = await startHarness({ core: { overrides: { spoolPollMs: undefined } } });
    const a = await h.project('GitManager', { conversations: ['https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] });
    const session = await h.start(a.project.id);
    const layout = await h.core.services.environments.layout('posix');
    const listed = new Map<string, number>();
    const watcher = setInterval(() => {
      let names: string[];
      try { names = fs.readdirSync(layout.spoolDirHost); } catch { return; }
      const now = performance.now();
      for (const name of names) if (name.endsWith('.json') && !listed.has(name)) listed.set(name, now);
    }, 1);
    let notifiedAt: number | null = null;
    const original = h.native.notify.bind(h.native);
    h.native.notify = async (n) => { notifiedAt ??= performance.now(); return original(n); };
    try {
      await h.type(session.key, `Done ${directive.report({ task: 'Latency' })}`);
      await h.waitFor('the report notification', () => notifiedAt !== null, 15_000);
      const row = h.core.base.db.get<{ transport_id: string }>(
        "SELECT transport_id FROM raw_events WHERE json_extract(entry_json, '$.payload.hook_event_name') = 'Stop' ORDER BY seq DESC LIMIT 1",
      )!;
      const wrote = listed.get([...listed.keys()].find((name) => name.includes(row.transport_id)) ?? '');
      if (wrote !== undefined) expect(notifiedAt! - wrote).toBeLessThan(BUDGET_MS);
    } finally { clearInterval(watcher); }
  }, 60_000);
});
