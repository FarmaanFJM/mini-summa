// The critical cross-project scenario from the product brief, run against the real core and a real PTY.
//
// Four projects, each with its own ChatGPT conversation (the fourth has none). Claude finishes tasks in several of them
// at the same time. Whatever is selected, focused or opened in the meantime, each report must be stored under the
// project and session that produced it, and its delivery must be frozen to THAT project's conversation, never another's.
import { afterEach, describe, expect, it } from 'vitest';
import type { Delivery, Report } from '@minisumma/shared';
import { directive } from '../../src/testing/fake-claude/index.ts';
import { cleanup, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

const CONV = {
  A: 'https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  B: 'https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  C: 'https://chatgpt.com/c/cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  C2: 'https://chatgpt.com/c/c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2',
};

let h: Harness;
afterEach(async () => { if (h) { await h.stop().catch(() => {}); cleanup(h); } });

async function reportsOf(projectId: string) {
  return (await h.client.call('reports.list', { query: { projectId } })).items;
}

describe('four projects, one conversation each', () => {
  it('stores every report under its own project and freezes every destination to that project\'s conversation', async () => {
    h = await startHarness();
    const A = await h.project('GitManager', { conversations: [CONV.A] });
    const B = await h.project("Herc's Adventure", { conversations: [CONV.B] });
    const C = await h.project('Chess Player Integrity', { conversations: [CONV.C, CONV.C2] });
    const D = await h.project('Markdown Studio', { conversations: [] });
    await h.client.call('conversations.setPreferred', { params: { id: C.project.id }, body: { conversationId: C.conversations[1].id } });

    const [sA, sB, sC, sD] = await Promise.all([A, B, C, D].map((p) => h.start(p.project.id)));
    expect(new Set([sA.key, sB.key, sC.key, sD.key]).size).toBe(4);
    for (const [s, p] of [[sA, A], [sB, B], [sC, C], [sD, D]] as const) {
      expect(s).toMatchObject({ origin: 'managed', projectId: p.project.id, availability: 'live' });
      expect(s.cwd).toBe(p.dir);
    }

    // Project B is "selected" and its conversation is the page in front, while Claude finishes work in A, C and D.
    h.native.focusedUrl = CONV.B;
    await Promise.all([
      h.type(sA.key, `Finish the storage system ${directive.report({ task: 'GitManager Storage System' })}`),
      h.type(sC.key, `Check the openings ${directive.report({ task: 'Chess Integrity Openings' })}`),
      h.type(sD.key, `Draft the parser ${directive.report({ task: 'Markdown Parser', status: 'partial' })}`),
    ]);

    await h.waitFor('three reports', async () => {
      const total = (await Promise.all([A, C, D].map((p) => reportsOf(p.project.id)))).flat();
      return total.length === 3 ? total : undefined;
    });

    const [ra] = await reportsOf(A.project.id);
    const [rc] = await reportsOf(C.project.id);
    const [rd] = await reportsOf(D.project.id);
    expect(await reportsOf(B.project.id)).toEqual([]);                       // B had no work: nothing is stored under it
    expect(ra).toMatchObject({ projectId: A.project.id, sessionKey: sA.key, taskTitle: 'GitManager Storage System', declaredStatus: 'complete' });
    expect(rc).toMatchObject({ projectId: C.project.id, sessionKey: sC.key, taskTitle: 'Chess Integrity Openings' });
    expect(rd).toMatchObject({ projectId: D.project.id, sessionKey: sD.key, declaredStatus: 'partial' });

    const delivery = async (r: { id: string }) => (await h.client.call('deliveries.list', { query: { reportId: r.id } }))[0] as Delivery;
    const dA = await delivery(ra); const dC = await delivery(rc); const dD = await delivery(rd);
    expect(dA.destination).toMatchObject({ url: CONV.A, resolvedFrom: 'project_preferred' });
    expect(dC.destination).toMatchObject({ url: CONV.C2, resolvedFrom: 'project_preferred' });   // C's preferred, not its first
    expect(dD.state).toBe('destination_missing');                                                  // D has no conversation: no guess
    expect(dD.destination).toBeNull();
    for (const d of [dA, dC]) expect(d.state).toBe('destination_unverified');                      // never claims "verified" it did not check
    expect([dA, dC, dD].map((d) => d.projectId)).toEqual([A.project.id, C.project.id, D.project.id]);

    // Nothing was ever prepared for B, and B's conversation received nothing.
    expect(await h.client.call('deliveries.list', { query: { projectId: B.project.id } })).toEqual([]);

    // Later changes cannot redirect what already exists: A's preferred conversation moves, A's delivery does not.
    const extra = await h.client.call('conversations.add', { params: { id: A.project.id }, body: { url: CONV.B, makePreferred: true } });
    expect(extra.url).toBe(CONV.B);
    expect((await delivery(ra)).destination!.url).toBe(CONV.A);

    // The handoff copies THIS report's text and opens THIS delivery's frozen conversation, whatever is focused.
    h.native.focusedUrl = CONV.B;
    const handoff = await h.client.call('deliveries.handoff', { params: { id: dA.id }, body: {} });
    expect(h.native.opened.at(-1)).toMatchObject({ url: CONV.A, focus: true, reason: 'handoff' });
    expect(h.native.clipboardWrites.at(-1)).toContain('GitManager Storage System');
    expect(h.native.clipboardWrites.at(-1)).toContain(ra.excerpt.slice(0, 20));
    expect(h.native.clipboardWrites.at(-1)).not.toContain('Chess Integrity Openings');
    expect(handoff.delivery.state).toBe('awaiting_user_send');
    expect(handoff.delivery.destination!.url).toBe(CONV.A);

    // Full text, verbatim, linked to the right project.
    const full = await h.client.call('reports.get', { params: { id: ra.id } }) as Report;
    expect(full.body).toContain('## Implementation Report');
    expect(full.body.trimEnd().endsWith('-->')).toBe(true);
    expect(full.projectId).toBe(A.project.id);
  }, 60_000);
});
