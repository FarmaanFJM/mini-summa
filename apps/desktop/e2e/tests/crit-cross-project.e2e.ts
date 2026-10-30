// CRIT: the scenario the product exists for. Four projects with four different ChatGPT mappings (C has two, the second preferred;
// D has none). Claude finishes tasks in A, C and D while B is the selected project and B's conversation is the page in front.
// A's report must be stored under A, frozen to A's conversation, and never prepared for B, C or D. The real "Copy and open" button,
// pressed while B is still selected, must put A's message on the clipboard and open A's conversation, and nothing else.
import { expect } from 'vitest';
import { ApiError } from '@minisumma/shared';
import type { Delivery } from '@minisumma/shared';
import { launchApp } from '../helpers/app.ts';
import { createProject, fullReport, latestDelivery, reportsOf, startSession } from '../helpers/core.ts';
import { evidence } from '../helpers/evidence.ts';
import { finishTask } from '../helpers/flow.ts';
import { allWebContentsUrls, chatgptView, readClipboard, standInPageState, writeClipboard } from '../helpers/main-process.ts';
import { makeRepo } from '../helpers/sandbox.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';
import { createProjectInUi, handoffCard, openReport, openReports, reportRow, selectProject } from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

const CONV = { A: uuidOf('a'), B: uuidOf('b'), C1: uuidOf('c1'), C2: uuidOf('c2') };
const NAMES = { A: 'GitManager', B: "Herc's Adventure", C: 'Chess Player Integrity', D: 'Markdown Studio' } as const;

scenario('[CRIT] A report from A is handed off to A\'s conversation while B is selected, and never to B, C or D', async () => {
  const h = await launchApp();
  for (const [id, title] of [[CONV.A, 'A'], [CONV.B, 'B'], [CONV.C1, 'C first'], [CONV.C2, 'C second']] as const) h.standIn.name(id, `Stand-in: ${title}`);

  // --- Configure the four projects in the real dialog.
  await createProjectInUi(h.page, { name: NAMES.A, folder: makeRepo(h.sandbox, 'GitManager'), conversations: [conversationUrl(CONV.A)] });
  await createProjectInUi(h.page, { name: NAMES.B, folder: makeRepo(h.sandbox, 'Hercs_Adventure'), conversations: [conversationUrl(CONV.B)] });
  await createProjectInUi(h.page, { name: NAMES.C, folder: makeRepo(h.sandbox, 'Chess_Player_Integrity'), conversations: [conversationUrl(CONV.C1), conversationUrl(CONV.C2)], preferred: 1 });
  await createProjectInUi(h.page, { name: NAMES.D, folder: makeRepo(h.sandbox, 'Markdown_Studio') });
  const projects = await h.api.call('projects.list');
  const byName = (name: string) => projects.find((p) => p.name === name)!;
  const [A, B, C, D] = [byName(NAMES.A), byName(NAMES.B), byName(NAMES.C), byName(NAMES.D)];
  const convsOf = async (id: string) => h.api.call('conversations.list', { params: { id } });
  const [convA, convB, convC, convD] = [await convsOf(A.id), await convsOf(B.id), await convsOf(C.id), await convsOf(D.id)];
  expect([convA.length, convB.length, convC.length, convD.length]).toEqual([1, 1, 2, 0]);
  expect(C.preferredConversationId).toBe(convC[1].id); // C prefers its SECOND conversation
  expect(D.preferredConversationId).toBeNull();

  // --- Four running sessions, one per project.
  const [sA, sB, sC, sD] = [await startSession(h, A.id), await startSession(h, B.id), await startSession(h, C.id), await startSession(h, D.id)];
  expect(new Set([sA.key, sB.key, sC.key, sD.key]).size).toBe(4);
  for (const [s, p] of [[sA, A], [sB, B], [sC, C], [sD, D]] as const) expect(s).toMatchObject({ origin: 'managed', availability: 'live', projectId: p.id });

  // --- B is the selected project, and B's conversation is the page in front.
  await selectProject(h.page, NAMES.B);
  await until("B's conversation to be the page in front", async () => {
    const view = await chatgptView(h.app);
    return view?.url === conversationUrl(CONV.B) && !view.loading;
  });

  // --- Claude finishes tasks in A, C and D (not in B).
  const rA = await finishTask(h, { project: A, session: sA }, 'GitManager Storage System');
  const rC = await finishTask(h, { project: C, session: sC }, 'Chess Integrity Openings');
  const rD = await finishTask(h, { project: D, session: sD }, 'Markdown Parser', 'partial');

  // Each report is stored under the project and the session that produced it.
  expect(rA).toMatchObject({ projectId: A.id, projectName: NAMES.A, sessionKey: sA.key, declaredStatus: 'complete' });
  expect(rC).toMatchObject({ projectId: C.id, sessionKey: sC.key });
  expect(rD).toMatchObject({ projectId: D.id, sessionKey: sD.key, declaredStatus: 'partial' });
  expect(await reportsOf(h, B.id)).toEqual([]);
  expect((await reportsOf(h)).map((r) => r.projectId).sort()).toEqual([A.id, C.id, D.id].sort());

  // Every destination is frozen to a conversation of its OWN project; A's is A's; nothing exists for B.
  const dA = await latestDelivery(h, rA.id);
  const dC = await latestDelivery(h, rC.id);
  const dD = await latestDelivery(h, rD.id);
  expect(dA.destination).toMatchObject({ url: conversationUrl(CONV.A), conversationId: convA[0].id });
  expect(dC.destination).toMatchObject({ url: conversationUrl(CONV.C2), conversationId: convC[1].id, resolvedFrom: 'project_preferred' }); // preferred, not first
  expect(dD.state).toBe('destination_missing');
  expect(dD.destination).toBeNull();
  const own: Record<string, string[]> = { [A.id]: convA.map((c) => c.id), [B.id]: convB.map((c) => c.id), [C.id]: convC.map((c) => c.id), [D.id]: [] };
  const allDeliveries = await h.api.call('deliveries.list');
  expect(allDeliveries).toHaveLength(3);
  for (const d of allDeliveries) if (d.destination) expect(own[d.projectId!], `delivery ${d.id} points into another project`).toContain(d.destination.conversationId);
  expect(await h.api.call('deliveries.list', { query: { projectId: B.id } })).toEqual([]);
  expect(await h.api.call('deliveries.list', { query: { reportId: rA.id } })).toHaveLength(1);
  // Capturing reports did not move the page in front: it is still B's.
  expect((await chatgptView(h.app))?.url).toBe(conversationUrl(CONV.B));
  expect(await h.page.getByRole('heading', { level: 1, name: NAMES.B }).isVisible()).toBe(true);

  // --- The real "Copy and open", pressed while B is still the selected project.
  await writeClipboard(h.app, 'previous clipboard content');
  await openReport(h.page, 'GitManager Storage System');
  const card = handoffCard(h.page);
  await card.getByLabel('Destination').getByText(conversationUrl(CONV.A), { exact: true }).waitFor();
  const mark = h.standIn.mark();
  await card.getByRole('button', { name: 'Copy and open' }).click();

  await until("the embedded ChatGPT view to show A's conversation", async () => {
    const view = await chatgptView(h.app);
    return view?.url === conversationUrl(CONV.A) && !view.loading && view.title === 'Stand-in: A';
  });
  // What the main process says is open, from webContents.getAllWebContents(): A's conversation, and none of B's, C's or D's.
  const urls = await allWebContentsUrls(h.app);
  expect(urls.filter((u) => u.startsWith('https://'))).toEqual([conversationUrl(CONV.A)]);
  for (const other of [CONV.B, CONV.C1, CONV.C2]) expect(urls.some((u) => u.includes(other))).toBe(false);

  // The system clipboard holds A's message: A's project, A's task, A's report, verbatim, and nothing of B, C or D.
  await until("the clipboard to hold A's message", async () => (await readClipboard(h.app)) !== 'previous clipboard content');
  const clip = await readClipboard(h.app);
  const full = await fullReport(h, rA.id);
  expect(clip).toContain(`Project: ${NAMES.A}`);
  expect(clip).toContain('Task: GitManager Storage System');
  expect(clip).toContain(`<<<MINI-SUMMA REPORT ${rA.id} BEGIN>>>\n${full.body}\n<<<MINI-SUMMA REPORT ${rA.id} END>>>`);
  for (const other of [NAMES.B, NAMES.C, NAMES.D, 'Chess Integrity Openings', 'Markdown Parser']) expect(clip, `A's message must not mention ${other}`).not.toContain(other);
  const prepared = await h.api.call('deliveries.prepare', { params: { id: dA.id } });
  expect(clip).toBe(prepared.message);

  // The stand-in server: one request since the click, for A's path; none for B, C or D.
  const seen = h.standIn.since(mark);
  expect(seen.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([`GET chatgpt.com/c/${CONV.A}`]);
  for (const other of [CONV.B, CONV.C1, CONV.C2]) expect(seen.some((r) => r.path.includes(other))).toBe(false);
  expect(h.standIn.requests.some((r) => r.path.includes(CONV.C1))).toBe(false); // C's other conversation was never loaded at all

  // The delivery waits for the person; B is still the selected project and the pane says that the page is not B's.
  const after = await until('the handoff to finish and wait for the person', async () => {
    const d = await latestDelivery(h, rA.id);
    return d.state === 'awaiting_user_send' ? d : null;
  });
  expect(after.destination).toEqual(dA.destination); // frozen: the same destination, byte for byte
  await h.page.getByRole('heading', { level: 1, name: NAMES.B }).waitFor();
  await h.page.getByText(/This page is not one of .* conversations\. Handoffs still go to the one you mapped\./).waitFor();
  expect(await h.api.call('deliveries.list', { query: { projectId: B.id } })).toEqual([]);
  expect(await standInPageState(h.app)).toEqual({ events: [], composer: '' }); // nothing typed, pasted or submitted into ChatGPT

  // --- D: no destination, and no way to hand the report to anything else.
  await openReports(h.page);
  await reportRow(h.page, 'Markdown Parser').click();
  const dCard = handoffCard(h.page);
  await dCard.getByText('No conversation chosen', { exact: true }).waitFor();
  await dCard.getByText('No ChatGPT conversation is set for this report, so there is nowhere to hand it to yet.').waitFor();
  const buttons = await dCard.getByRole('button').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim()));
  expect(buttons).toContain('Add a ChatGPT conversation');
  expect(buttons.filter((name) => /copy|open|sent|check/i.test(name))).toEqual([]);
  expect(await dCard.getByLabel('Destination').count()).toBe(0);
  // The core refuses too: there is nothing to copy to, open, or hand off.
  const clipBeforeRefusals = await readClipboard(h.app);
  const urlBeforeRefusals = (await chatgptView(h.app))?.url;
  const requestsBeforeRefusals = h.standIn.mark();
  for (const attempt of [
    () => h.api.call('deliveries.handoff', { params: { id: dD.id }, body: {} }),
    () => h.api.call('deliveries.copy', { params: { id: dD.id }, body: {} }),
    () => h.api.call('deliveries.open', { params: { id: dD.id } }),
  ]) {
    const error = await attempt().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'destination_missing' });
  }
  expect(await readClipboard(h.app)).toBe(clipBeforeRefusals);
  expect((await chatgptView(h.app))?.url).toBe(urlBeforeRefusals);
  expect(h.standIn.since(requestsBeforeRefusals)).toEqual([]);
  const dDAfter: Delivery = await latestDelivery(h, rD.id);
  expect(dDAfter).toMatchObject({ state: 'destination_missing', destination: null });

  // --- C: the second, preferred conversation, shown as such.
  await reportRow(h.page, 'Chess Integrity Openings').click();
  await handoffCard(h.page).getByLabel('Destination').getByText(conversationUrl(CONV.C2), { exact: true }).waitFor();
  evidence('CRIT', `four projects (C with two conversations and the second preferred, D with none) configured in the real dialog, a running session in each; with ${NAMES.B} selected and its conversation in front, Claude finished tasks in ${NAMES.A}, C and D: the reports were stored under their own projects and sessions, none under B; A's delivery was frozen to A's conversation (${conversationUrl(CONV.A)}), C's to its preferred second one, D's is destination_missing with no handoff button and the core refusing handoff/copy/open (409 destination_missing); pressing the real "Copy and open" while B was still selected left A's message (byte-identical to the prepared message, no mention of B, C or D) on the clipboard, getAllWebContents() listed only ${conversationUrl(CONV.A)}, the stand-in saw exactly one request since the click (GET /c/${CONV.A}) and none for B, C or D, the delivery is awaiting_user_send and still frozen, and the page's composer is empty`);
  void convD;
  void fullReport;
}, { timeout: 180_000 });
