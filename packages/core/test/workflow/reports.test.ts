import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryState, ReportSummary } from '@minisumma/shared';
import type { CapturedCandidate, CapturedReport } from '../../src/contracts.ts';
import { createReportsService, makeExcerpt } from '../../src/workflow/reports.ts';
import { KEY_A, KEY_B, hasEmDash, makeEnv } from './helpers.ts';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const MARKER_NOTE = 'The marker is a declaration written by the model, not evidence that the work or its tests succeeded.';
const BODY = '## Implementation Report\n\nFixed the login redirect.\n\n<!-- mini-summa:report status=complete task="Fix login" -->';

let counter = 0;
const captured = (over: Partial<CapturedReport> = {}): CapturedReport => {
  counter++;
  const body = over.body ?? BODY;
  return {
    reportId: `r${String(counter).padStart(15, '0')}`, sessionKey: KEY_A, env: 'win', sessionId: 'a1b2c3d4-1111-4111-8111-111111111111', generation: 1,
    projectId: null, projectName: null, cwd: 'C:\\dev\\gm', promptId: 'p1', taskId: `${KEY_A}:p1`, taskTitle: 'Fix login', declaredStatus: 'complete', body,
    bodySha256: sha256(body), stopHookActive: false, late: false, capturedSeq: counter, note: MARKER_NOTE, capturedAt: '2026-10-30T09:59:00.000Z', ...over,
  };
};

const candidate = (over: Partial<CapturedCandidate> = {}): CapturedCandidate => {
  counter++;
  const body = over.body ?? 'I looked at the code and everything seems fine.';
  return {
    candidateId: `c${String(counter).padStart(15, '0')}`, sessionKey: KEY_A, env: 'win', sessionId: 'a1b2c3d4-1111-4111-8111-111111111111', generation: 1,
    projectId: null, projectName: null, promptId: 'p2', reason: 'no report marker', declaredStatus: null, taskTitle: null, body, bodySha256: sha256(body),
    late: false, capturedAt: '2026-10-30T09:58:00.000Z', ...over,
  };
};

function setup(onCreated?: (r: ReportSummary, ctx: { via: 'capture' | 'promote' }) => void) {
  const env = makeEnv();
  const calls: { report: ReportSummary; via: string }[] = [];
  const svc = createReportsService({ base: env.base, onCreated: (report, ctx) => { calls.push({ report, via: ctx.via }); onCreated?.(report, ctx); } });
  env.db.run(`INSERT INTO projects (id, name, default_env, notification_prefs_json, created_at, updated_at) VALUES ('prj_gm','GitManager','win','{}','t','t'),('prj_oth','Other','win','{}','t','t')`);
  const addDelivery = (over: { id: string; reportId: string; state: DeliveryState; createdAt: string; updatedAt: string; title?: string | null }) =>
    env.db.run(
      `INSERT INTO deliveries (id, report_id, session_key, task_title, state, destination_json, state_changed_at, created_at, updated_at) VALUES (?, ?, ?, 'Fix login', ?, ?, ?, ?, ?)`,
      [over.id, over.reportId, KEY_A, over.state, over.title === null ? null : JSON.stringify({ title: over.title ?? 'Main chat' }), over.createdAt, over.createdAt, over.updatedAt],
    );
  return { env, svc, calls, addDelivery };
}

describe('reports.capture', () => {
  it('stores a report and returns its summary', () => {
    const { env, svc } = setup();
    const r = captured({ projectId: 'prj_gm', projectName: 'GitManager', late: true });
    const { report, created } = svc.capture(r);
    expect(created).toBe(true);
    expect(report).toEqual({
      id: r.reportId, projectId: 'prj_gm', projectName: 'GitManager', sessionKey: KEY_A, env: 'win', sessionId: r.sessionId, generation: 1, taskTitle: 'Fix login',
      declaredStatus: 'complete', source: 'marker', capturedAt: '2026-10-30T09:59:00.000Z', late: true, read: false, chars: BODY.length,
      excerpt: BODY.replace(/\s+/g, ' ').trim(), delivery: null,
    });
    expect(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reports')!.n).toBe(1);
  });

  it('emits report.upserted with the summary only, never the body, and calls onCreated after the row is committed', () => {
    let seenInCallback: { row: unknown; events: number } | null = null;
    const t = setup();
    const svc = createReportsService({
      base: t.env.base,
      onCreated: (report, ctx) => {
        seenInCallback = { row: t.env.db.get('SELECT id FROM reports WHERE id = ?', [report.id]), events: t.env.of('report.upserted').length };
        expect(ctx).toEqual({ via: 'capture' });
      },
    });
    // the summary carries a 240 character excerpt on purpose; anything beyond it is the body and must not travel
    const r = captured({ body: `${BODY}\n${'padding '.repeat(60)}\nSECRET-MARKER-IN-BODY` });
    const { report } = svc.capture(r);
    expect(t.env.of('report.upserted')).toEqual([{ type: 'report.upserted', report }]);
    expect(JSON.stringify(t.env.of('report.upserted'))).not.toContain('SECRET-MARKER-IN-BODY');
    expect(report).not.toHaveProperty('body');
    expect(Object.keys(report).sort()).toEqual(['capturedAt', 'chars', 'declaredStatus', 'delivery', 'env', 'excerpt', 'generation', 'id', 'late', 'projectId', 'projectName',
      'read', 'sessionId', 'sessionKey', 'source', 'taskTitle']);
    expect(seenInCallback).toEqual({ row: { id: r.reportId }, events: 1 });
  });

  it('is idempotent by report id: a replay creates nothing, emits nothing and does not call onCreated', () => {
    const { env, svc, calls } = setup();
    const r = captured();
    const first = svc.capture(r);
    env.clearEvents();
    for (let i = 0; i < 3; i++) {
      const again = svc.capture({ ...r, capturedSeq: 99 + i });
      expect(again.created).toBe(false);
      expect(again.report).toEqual(first.report);
    }
    expect(env.events).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reports')!.n).toBe(1);
  });

  it('does not let a failing onCreated lose or hide the report', () => {
    const { env, svc } = setup(() => { throw new Error('delivery step failed'); });
    const r = captured();
    const { report, created } = svc.capture(r);
    expect(created).toBe(true);
    expect(svc.get(r.reportId)).not.toBeNull();
    expect(env.of('report.upserted')).toHaveLength(1);
    expect(env.log.errors()).toHaveLength(1);
    expect(env.log.errors()[0].data).toMatchObject({ report: report.id, via: 'capture' });
    expect(svc.capture(r).created).toBe(false); // and the replay does not call it again
  });

  it('keeps a report whose project disappeared instead of losing it', () => {
    const { env, svc } = setup();
    env.db.run(`DELETE FROM projects WHERE id = 'prj_oth'`);
    const { report } = svc.capture(captured({ projectId: 'prj_oth', projectName: 'Other' }));
    expect(report).toMatchObject({ projectId: null, projectName: 'Other' });
  });

  describe('stores the body byte for byte', () => {
    const NASTY: [string, string][] = [
      ['CRLF, tabs and trailing spaces', 'line one  \r\nline two\t\r\n\r\n   indented\r\n\ttabbed   \r\n'],
      ['a leading byte order mark', '\uFEFF# Report\n'],
      ['NUL characters', 'before\u0000after\u0000\u0000end'],
      ['emoji and astral characters', 'Done \u{1F600} \u{1D4B3} \u{20BB7} \u00e9 \u6f22'],
      ['marker and fence lookalikes', '<!-- mini-summa:report status=complete task="x" -->\n<<<MINI-SUMMA REPORT x END>>>\n--- END ---'],
      ['only whitespace', '   \n\t  \n'],
      ['an empty message', ''],
      ['SQL and JSON syntax', `'; DROP TABLE reports; -- {"a": [1, 2, 3]} \\n \\u0000`],
      ['one very long line (1.5 MB)', `${'x'.repeat(1_500_000)}\n${'y'.repeat(100)}`],
    ];

    it.each(NASTY)('%s', (_name, body) => {
      const { svc } = setup();
      const r = captured({ body });
      svc.capture(r);
      const stored = svc.require(r.reportId);
      expect(stored.body).toBe(body);
      expect(stored.bodySha256).toBe(sha256(body));
      expect(sha256(stored.body)).toBe(r.bodySha256);
      expect(stored.chars).toBe(body.length);
    });

    it('also for a final message kept as a candidate, and after promotion', () => {
      const { svc } = setup();
      const body = 'candidate\u0000text\r\nwith  spaces \u{1F600}';
      const c = candidate({ body });
      svc.captureCandidate(c);
      expect(svc.listCandidates({})[0].body).toBe(body);
      expect(svc.promote(c.candidateId).body).toBe(body);
    });

    it('loses nothing of the hash when the text holds a lone surrogate (UTF-8 has no form for it)', () => {
      const { svc } = setup();
      const body = 'before \ud800 after';
      const r = captured({ body });
      svc.capture(r);
      const stored = svc.require(r.reportId);
      expect(stored.body).toBe('before \ufffd after');
      expect(sha256(stored.body)).toBe(sha256(body));
    });
  });
});

describe('reports: summary fields', () => {
  it('chars is the body length and the excerpt is the first 240 characters with whitespace collapsed', () => {
    const { svc } = setup();
    const long = `## Title\n\n${'word   word\n'.repeat(100)}`;
    const { report } = svc.capture(captured({ body: long }));
    expect(report.chars).toBe(long.length);
    expect(report.excerpt).toBe(long.replace(/\s+/g, ' ').trim().slice(0, 240));
    expect(report.excerpt.length).toBe(240);
    expect(report.excerpt).not.toMatch(/\s{2}|\n|\t/);
  });

  it.each([
    ['a short body is kept whole', 'Done.', 'Done.'],
    ['runs of whitespace and newlines collapse', '  a \n\n\t b\r\n c  ', 'a b c'],
    ['an empty body gives an empty excerpt', '', ''],
  ])('makeExcerpt: %s', (_name, body, expected) => {
    expect(makeExcerpt(body)).toBe(expected);
  });

  it('never cuts a surrogate pair in half and never exceeds the limit', () => {
    const body = `${'a'.repeat(239)}\u{1F600}tail`;
    const excerpt = makeExcerpt(body);
    expect(excerpt).toBe('a'.repeat(239));
    expect(excerpt.length).toBeLessThanOrEqual(240);
    expect(makeExcerpt('\u{1F600}'.repeat(300)).length).toBeLessThanOrEqual(240);
  });
});

describe('reports: redactions and truncations', () => {
  it('stores them on capture, returns redactions on the full report and defaults to 0', () => {
    const { env, svc } = setup();
    const a = captured({ redactions: 3, truncations: 1 });
    const b = captured();
    svc.capture(a);
    svc.capture(b);
    expect(svc.require(a.reportId).redactions).toBe(3);
    expect(svc.require(b.reportId).redactions).toBe(0);
    expect(env.db.get<{ redactions: number; truncations: number }>('SELECT redactions, truncations FROM reports WHERE id = ?', [a.reportId])).toEqual({ redactions: 3, truncations: 1 });
    expect(env.db.get<{ redactions: number; truncations: number }>('SELECT redactions, truncations FROM reports WHERE id = ?', [b.reportId])).toEqual({ redactions: 0, truncations: 0 });
  });

  it('treats a negative, fractional or unreadable count as what it can be', () => {
    const { env, svc } = setup();
    for (const [redactions, expected] of [[-2, 0], [Number.NaN, 0], [2.9, 2], [Number.POSITIVE_INFINITY, 0]] as const) {
      const r = captured({ redactions, truncations: redactions });
      svc.capture(r);
      expect(env.db.get('SELECT redactions, truncations FROM reports WHERE id = ?', [r.reportId])).toEqual({ redactions: expected, truncations: expected });
    }
  });

  it('keeps the first capture\'s counts when the same report is captured again', () => {
    const { svc } = setup();
    const r = captured({ redactions: 2 });
    svc.capture(r);
    svc.capture({ ...r, redactions: 9 });
    expect(svc.require(r.reportId).redactions).toBe(2);
  });

  it('keeps them on a candidate, and carries both to the report it is promoted to', () => {
    const { env, svc } = setup();
    const c = candidate({ redactions: 4, truncations: 2 });
    const plain = candidate();
    expect(svc.captureCandidate(c).created).toBe(true);
    svc.captureCandidate(plain);
    const listed = svc.listCandidates({});
    expect(listed.find((x) => x.id === c.candidateId)!.redactions).toBe(4);
    expect(listed.find((x) => x.id === plain.candidateId)!.redactions).toBe(0);
    expect(env.db.get('SELECT redactions, truncations FROM report_candidates WHERE id = ?', [c.candidateId])).toEqual({ redactions: 4, truncations: 2 });

    const report = svc.promote(c.candidateId);
    expect(report.redactions).toBe(4);
    expect(env.db.get('SELECT redactions, truncations FROM reports WHERE id = ?', [c.candidateId])).toEqual({ redactions: 4, truncations: 2 });
    expect(svc.promote(plain.candidateId).redactions).toBe(0);
  });
});

describe('reports.list', () => {
  it('returns newest first by capture time, ties by arrival, and pages with the cursor without loss or repeats', () => {
    const { svc } = setup();
    const times = ['2026-10-30T08:00:00.000Z', '2026-10-30T10:00:00.000Z', '2026-10-30T10:00:00.000Z', '2026-10-30T09:00:00.000Z', '2026-10-30T10:00:00.000Z', '2026-10-30T07:00:00.000Z'];
    const ids = times.map((capturedAt) => { const r = captured({ capturedAt }); svc.capture(r); return r.reportId; });
    const expected = [ids[4], ids[2], ids[1], ids[3], ids[0], ids[5]];
    expect(svc.list({}).items.map((r) => r.id)).toEqual(expected);
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = svc.list({ limit: 2, before });
      seen.push(...page.items.map((r) => r.id));
      before = page.nextBefore ?? undefined;
    } while (before);
    expect(seen).toEqual(expected);
  });

  it('filters by project and unread, and clamps the limit', () => {
    const { svc } = setup();
    const a = captured({ projectId: 'prj_gm', projectName: 'GitManager' });
    const b = captured({ projectId: 'prj_oth', projectName: 'Other' });
    const c = captured({ projectId: 'prj_gm', projectName: 'GitManager' });
    for (const r of [a, b, c]) svc.capture(r);
    svc.markRead(a.reportId);
    expect(svc.list({ projectId: 'prj_gm' }).items.map((r) => r.id)).toEqual([c.reportId, a.reportId]);
    expect(svc.list({ projectId: 'prj_gm', unread: true }).items.map((r) => r.id)).toEqual([c.reportId]);
    expect(svc.list({ unread: false }).items).toHaveLength(3);
    expect(svc.list({ limit: 0 }).items).toHaveLength(1);
    expect(svc.list({ limit: 5000 }).items).toHaveLength(3);
    expect(svc.list({ limit: 1 }).nextBefore).not.toBeNull();
    expect(svc.list({}).nextBefore).toBeNull();
  });

  it('rejects a cursor it did not hand out', () => {
    const { svc } = setup();
    for (const before of ['nonsense', '|5', '2026-10-30T09:00:00.000Z|x', '2026-10-30T09:00:00.000Z|']) {
      expect(() => svc.list({ before })).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_cursor' }));
    }
  });

  it('shows the latest delivery of each report', () => {
    const { svc, addDelivery } = setup();
    const r = captured();
    svc.capture(r);
    addDelivery({ id: 'dlv_1', reportId: r.reportId, state: 'user_discarded', createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:30:00.000Z', title: 'Old chat' });
    addDelivery({ id: 'dlv_2', reportId: r.reportId, state: 'copied', createdAt: '2026-10-30T11:00:00.000Z', updatedAt: '2026-10-30T11:05:00.000Z', title: 'New chat' });
    expect(svc.list({}).items[0].delivery).toEqual({ id: 'dlv_2', state: 'copied', review: 'none', destinationTitle: 'New chat', updatedAt: '2026-10-30T11:05:00.000Z' });
    expect(svc.summary(r.reportId)!.delivery!.id).toBe('dlv_2');
  });
});

describe('reports.get / require / summary', () => {
  it('returns the full report, never verified, with the declaration note and every delivery oldest first', () => {
    const { svc, addDelivery } = setup();
    const r = captured({ projectId: 'prj_gm', projectName: 'GitManager', redactions: 1 });
    svc.capture(r);
    addDelivery({ id: 'dlv_a', reportId: r.reportId, state: 'user_confirmed_sent', createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:05:00.000Z' });
    addDelivery({ id: 'dlv_b', reportId: r.reportId, state: 'destination_missing', createdAt: '2026-10-30T11:00:00.000Z', updatedAt: '2026-10-30T11:00:00.000Z', title: null });
    const report = svc.require(r.reportId);
    expect(report).toMatchObject({
      id: r.reportId, body: BODY, bodySha256: sha256(BODY), promptId: 'p1', taskId: r.taskId, cwd: 'C:\\dev\\gm', stopHookActive: false, verified: false, redactions: 1,
      source: 'marker', declaredStatus: 'complete',
    });
    expect(report.note).toMatch(/declaration/i);
    expect(report.note).toMatch(/not evidence/i);
    expect(report.deliveries.map((d) => [d.id, d.state, d.destinationTitle])).toEqual([['dlv_a', 'user_confirmed_sent', 'Main chat'], ['dlv_b', 'destination_missing', null]]);
    expect(report.delivery!.id).toBe('dlv_b');
    expect(svc.get(r.reportId)).toEqual(report);
  });

  it('adds the declaration note when the capture note does not say it, and keeps it when it does', () => {
    const { svc } = setup();
    const quiet = captured({ note: 'Captured late.' });
    const said = captured({ note: MARKER_NOTE });
    const blank = captured({ note: '' });
    for (const r of [quiet, said, blank]) svc.capture(r);
    expect(svc.require(quiet.reportId).note).toMatch(/^Captured late\. .*declaration by Claude, not evidence/);
    expect(svc.require(said.reportId).note).toBe(MARKER_NOTE);
    expect(svc.require(blank.reportId).note).toMatch(/declaration by Claude, not evidence/);
    expect(hasEmDash(svc.require(quiet.reportId).note)).toBe(false);
  });

  it('answers null for an unknown report from get and summary, and 404 from require', () => {
    const { svc } = setup();
    expect(svc.get('nope')).toBeNull();
    expect(svc.summary('nope')).toBeNull();
    expect(() => svc.require('nope')).toThrowError(expect.objectContaining({ status: 404, code: 'not_found' }));
  });
});

describe('reports.markRead', () => {
  it('marks a report read once, emitting the updated summary only when it changed', () => {
    const { env, svc } = setup();
    const r = captured();
    svc.capture(r);
    env.clearEvents();
    const read = svc.markRead(r.reportId);
    expect(read.read).toBe(true);
    expect(env.of('report.upserted')).toEqual([{ type: 'report.upserted', report: read }]);
    env.clearEvents();
    expect(svc.markRead(r.reportId).read).toBe(true);
    expect(env.events).toEqual([]);
    expect(() => svc.markRead('nope')).toThrowError(expect.objectContaining({ status: 404 }));
  });
});

describe('reports: candidates', () => {
  it('stores a final message that did not follow the protocol, idempotently, and never discards it', () => {
    const { env, svc } = setup();
    const c = candidate({ projectId: 'prj_gm', projectName: 'GitManager', declaredStatus: 'partial', taskTitle: 'Half done', late: true });
    expect(svc.captureCandidate(c)).toEqual({ created: true });
    env.clearEvents();
    expect(svc.captureCandidate(c)).toEqual({ created: false });
    expect(svc.captureCandidate({ ...c, reason: 'changed my mind' })).toEqual({ created: false });
    expect(env.events).toEqual([]);
    expect(svc.listCandidates({})).toEqual([{
      id: c.candidateId, projectId: 'prj_gm', projectName: 'GitManager', sessionKey: KEY_A, env: 'win', sessionId: c.sessionId, generation: 1, promptId: 'p2',
      reason: 'no report marker', declaredStatus: 'partial', taskTitle: 'Half done', body: c.body, bodySha256: c.bodySha256, capturedAt: c.capturedAt, late: true,
      promoted: false, redactions: 0,
    }]);
  });

  it('lists newest first, by project, hiding promoted ones unless asked', () => {
    const { svc } = setup();
    const a = candidate({ projectId: 'prj_gm', capturedAt: '2026-10-30T08:00:00.000Z' });
    const b = candidate({ projectId: 'prj_oth', capturedAt: '2026-10-30T09:00:00.000Z' });
    const c = candidate({ projectId: 'prj_gm', capturedAt: '2026-10-30T10:00:00.000Z' });
    for (const x of [a, b, c]) svc.captureCandidate(x);
    expect(svc.listCandidates({}).map((x) => x.id)).toEqual([c.candidateId, b.candidateId, a.candidateId]);
    expect(svc.listCandidates({ projectId: 'prj_gm' }).map((x) => x.id)).toEqual([c.candidateId, a.candidateId]);
    svc.promote(c.candidateId);
    expect(svc.listCandidates({}).map((x) => x.id)).toEqual([b.candidateId, a.candidateId]);
    const withPromoted = svc.listCandidates({ includePromoted: true });
    expect(withPromoted.map((x) => [x.id, x.promoted])).toEqual([[c.candidateId, true], [b.candidateId, false], [a.candidateId, false]]);
  });

  it('promotes a candidate into a report with the same id, source user_promoted and the text untouched', () => {
    const { env, svc, calls } = setup();
    const c = candidate({ projectId: 'prj_gm', projectName: 'GitManager', declaredStatus: 'blocked', taskTitle: 'Needs a decision', late: true,
      body: `It is blocked on the API key.\n\n${'context '.repeat(60)}\nPlease advise.` });
    svc.captureCandidate(c);
    env.clearEvents();
    const report = svc.promote(c.candidateId);
    expect(report).toMatchObject({
      id: c.candidateId, source: 'user_promoted', body: c.body, bodySha256: c.bodySha256, taskTitle: 'Needs a decision', declaredStatus: 'blocked', projectId: 'prj_gm',
      projectName: 'GitManager', sessionKey: KEY_A, generation: 1, capturedAt: c.capturedAt, late: true, read: false, verified: false, cwd: null,
    });
    expect(report.note).toMatch(/Promoted by you/);
    expect(report.note).toMatch(/no report marker/);
    expect(report.note).toMatch(/declaration by Claude, not evidence/);
    expect(env.of('report.upserted')).toHaveLength(1);
    expect(env.of('report.upserted')[0].report).toMatchObject({ id: c.candidateId, source: 'user_promoted' });
    expect(JSON.stringify(env.events)).not.toContain('Please advise');
    expect(calls.map((x) => [x.report.id, x.via])).toEqual([[c.candidateId, 'promote']]);
    expect(svc.listCandidates({ includePromoted: true })[0].promoted).toBe(true);
    expect(env.db.get('SELECT promoted_report_id FROM report_candidates WHERE id = ?', [c.candidateId])).toEqual({ promoted_report_id: c.candidateId });
  });

  it('says plainly that a missing status and title were filled in', () => {
    const { svc } = setup();
    const c = candidate({ body: '# Notes on the login flow\n\nMore text.' });
    svc.captureCandidate(c);
    const report = svc.promote(c.candidateId);
    expect(report.declaredStatus).toBe('partial');
    expect(report.note).toMatch(/declared no status/);
    expect(report.taskTitle).toBe('Notes on the login flow');
    const blank = candidate({ body: '   \n ' });
    svc.captureCandidate(blank);
    expect(svc.promote(blank.candidateId).taskTitle).toBe('Final message promoted to a report');
    expect(hasEmDash(report)).toBe(false);
  });

  it('promoting twice returns the same report without a second event or onCreated', () => {
    const { env, svc, calls } = setup();
    const c = candidate();
    svc.captureCandidate(c);
    const first = svc.promote(c.candidateId);
    env.clearEvents();
    expect(svc.promote(c.candidateId)).toEqual(first);
    expect(env.events).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reports')!.n).toBe(1);
  });

  it('answers 404 for a candidate that does not exist', () => {
    const { svc } = setup();
    expect(() => svc.promote('nope')).toThrowError(expect.objectContaining({ status: 404, code: 'not_found' }));
  });
});

describe('reports.prune', () => {
  const CUTOFF = '2026-06-01T00:00:00.000Z';
  const OLD = '2026-01-01T00:00:00.000Z';
  const NEW = '2026-09-01T00:00:00.000Z';

  it('removes old reports, with their closed deliveries, and keeps recent ones', () => {
    const { env, svc, addDelivery } = setup();
    const old = captured({ capturedAt: OLD });
    const fresh = captured({ capturedAt: NEW });
    svc.capture(old); svc.capture(fresh);
    addDelivery({ id: 'dlv_old', reportId: old.reportId, state: 'user_confirmed_sent', createdAt: OLD, updatedAt: OLD });
    env.db.run(`INSERT INTO delivery_events (id, delivery_id, at, type, actor_json) VALUES ('evt_1','dlv_old','${OLD}','created','{}')`);
    expect(svc.prune(CUTOFF)).toBe(1);
    expect(svc.get(old.reportId)).toBeNull();
    expect(svc.get(fresh.reportId)).not.toBeNull();
    expect(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries')!.n).toBe(0);
    expect(env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM delivery_events')!.n).toBe(0);
  });

  it('keeps an old report while a delivery is still open or was touched after the cutoff', () => {
    const { svc, addDelivery } = setup();
    const open = captured({ capturedAt: OLD });
    const recentlyClosed = captured({ capturedAt: OLD });
    const longClosed = captured({ capturedAt: OLD });
    for (const r of [open, recentlyClosed, longClosed]) svc.capture(r);
    addDelivery({ id: 'dlv_open', reportId: open.reportId, state: 'awaiting_user_send', createdAt: OLD, updatedAt: OLD });
    addDelivery({ id: 'dlv_recent', reportId: recentlyClosed.reportId, state: 'user_discarded', createdAt: OLD, updatedAt: NEW });
    addDelivery({ id: 'dlv_long', reportId: longClosed.reportId, state: 'user_discarded', createdAt: OLD, updatedAt: OLD });
    expect(svc.prune(CUTOFF)).toBe(1);
    expect([open, recentlyClosed, longClosed].map((r) => svc.get(r.reportId) !== null)).toEqual([true, true, false]);
  });

  it('also drops candidates older than the cutoff but counts reports only', () => {
    const { svc } = setup();
    svc.captureCandidate(candidate({ capturedAt: OLD }));
    svc.captureCandidate(candidate({ capturedAt: NEW }));
    svc.capture(captured({ capturedAt: OLD }));
    expect(svc.prune(CUTOFF)).toBe(1);
    expect(svc.listCandidates({ includePromoted: true })).toHaveLength(1);
  });

  it('is a no-op on a fresh database', () => {
    const { svc } = setup();
    expect(svc.prune(CUTOFF)).toBe(0);
    vi.useRealTimers();
  });
});
