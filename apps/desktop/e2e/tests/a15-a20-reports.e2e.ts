// A15-A20: what Claude does shows up in the feed; a finished task becomes a report tied to its project and session; the report can
// be copied whole; the handoff opens the conversation the report was frozen to, and never another project's.
import crypto from 'node:crypto';
import { expect } from 'vitest';
import { launchApp } from '../helpers/app.ts';
import { acceptsInput, createProject, fullReport, latestDelivery, reportsOf, startSession, waitForReports } from '../helpers/core.ts';
import { evidence } from '../helpers/evidence.ts';
import { directive } from '../helpers/fake-claude.ts';
import { finishTask, sceneWithSession } from '../helpers/flow.ts';
import { chatgptView, readClipboard, standInPageState, writeClipboard } from '../helpers/main-process.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';
import { observe, typeLikeAPerson, waitForScreen } from '../helpers/terminal.ts';
import { handoffCard, openActivity, openReport, openReports, projectRow, projectRowWith, reportDetail, reportList, reportRow, selectProject } from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

const A = uuidOf('a');
const B = uuidOf('b');
const C1 = uuidOf('c1');
const C2 = uuidOf('c2');

const sha256 = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

scenario('[A15] Claude activity appears in the feed', async () => {
  const h = await launchApp();
  const scene = await sceneWithSession(h, 'Alpha');
  const tag = scene.session.sessionId.slice(0, 8);
  await openActivity(h.page);
  const feed = h.page.getByRole('feed', { name: 'Activity feed' });

  // The start of the session is already there, unread, with the project and the session named.
  await feed.getByRole('button', { name: new RegExp(`Claude session started: Alpha / ${tag}`) }).waitFor();
  await h.page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: /^Activity, \d+ unread/ }).waitFor();

  // Things Claude does while the feed is open appear live: a permission request, a question, a failed turn, a report.
  const stream = await observe(h, scene.session.key);
  await stream.type(`run a command ${directive.permission('bash', 'echo from-fake')}`);
  await feed.getByRole('button', { name: new RegExp(`Needs permission: Alpha / ${tag}.*Needs attention.*Needs you`) }).waitFor();
  await stream.type('\r', { submit: false }); // the person answers the dialog in the terminal (Enter approves)
  await stream.waitFor('from-fake');
  await until('Claude to be done with the turn after the permission', async () => acceptsInput(await h.api.call('sessions.get', { params: { key: scene.session.key } })));

  await stream.type(`ask me ${directive.input('Which branch should I use?')}`);
  await feed.getByRole('button', { name: new RegExp(`Needs your input: Alpha / ${tag}`) }).waitFor();
  await stream.type('main'); // the answer
  await until('Claude to be done with the turn after the question', async () => acceptsInput(await h.api.call('sessions.get', { params: { key: scene.session.key } })));

  await stream.type(`this will fail ${directive.error('api_error')}`);
  await feed.getByRole('button', { name: new RegExp(`Error in Alpha / ${tag}.*Error`) }).waitFor();

  await finishTask(h, scene, 'Ship the importer');
  await feed.getByRole('button', { name: /Report ready: Ship the importer.*Alpha.*Needs attention/ }).waitFor();

  // The API says the same, with the kinds the core records.
  const kinds = (await h.api.call('activity.list', { query: { limit: 50 } })).items.map((a) => a.type);
  for (const kind of ['session_started', 'needs_permission', 'needs_input', 'error', 'report_ready']) expect(kinds).toContain(kind);

  // An entry leads to what it is about: the report entry opens the report.
  await feed.getByRole('button', { name: /Report ready: Ship the importer/ }).click();
  await reportDetail(h.page).getByRole('heading', { level: 1, name: 'Ship the importer' }).waitFor();
  evidence('A15', `with the Activity view open: "Claude session started", "Needs permission", "Needs your input", "Error in" and "Report ready: Ship the importer" appeared for Alpha / ${tag} as Claude did each thing (kinds ${kinds.filter((k, i) => kinds.indexOf(k) === i).join(', ')}); unread count shown in the sidebar; clicking the report entry opened the report`);
});

scenario('[A16] A completion report can be captured', async () => {
  const h = await launchApp();
  const scene = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  await selectProject(h.page, 'Alpha');
  await waitForScreen(h.page, 'for shortcuts');

  // A person types the work request; Claude (the fake) ends its turn with the report marker.
  await typeLikeAPerson(h.page, `Wrap up the storage layer ${directive.report({ task: 'Storage layer', status: 'complete' })}`);
  const [report] = await waitForReports(h, scene.project.id, 1);
  expect(report).toMatchObject({ taskTitle: 'Storage layer', declaredStatus: 'complete', source: 'marker', projectId: scene.project.id, sessionKey: scene.session.key, late: false });
  const full = await fullReport(h, report.id);
  expect(full.body).toContain('## Implementation Report');
  expect(full.body.trimEnd().endsWith('<!-- mini-summa:report status=complete task="Storage layer" -->')).toBe(true);

  // Stop is not completion: a turn that ends without the marker is not a report. It is kept, and offered as "other message".
  await typeLikeAPerson(h.page, 'just chatting, no report here');
  await waitForScreen(h.page, 'Echo: just chatting');
  const candidates = await until('the unmarked final message to be kept as a candidate', async () => {
    const list = await h.api.call('candidates.list', { query: { projectId: scene.project.id } });
    return list.length === 1 ? list : null;
  });
  expect(candidates[0].body).toContain('just chatting');
  expect(await reportsOf(h, scene.project.id)).toHaveLength(1);

  // Partial and blocked are what Claude declared, shown as a declaration and not as a fact.
  const partial = await finishTask(h, scene, 'Half the migration', 'partial');
  const blocked = await finishTask(h, scene, 'Blocked on credentials', 'blocked');
  expect([partial.declaredStatus, blocked.declaredStatus]).toEqual(['partial', 'blocked']);

  // The report is on screen in the queue with its facts, and opens to the full text.
  await openReports(h.page);
  await reportRow(h.page, 'Storage layer').waitFor();
  const label = (await reportRow(h.page, 'Storage layer').getAttribute('aria-label')) ?? '';
  expect(label).toContain('Alpha');
  expect(label).toContain('Declared complete by Claude');
  expect(label).toContain('Unread');
  expect((await reportRow(h.page, 'Half the migration').getAttribute('aria-label')) ?? '').toContain('Declared partial by Claude');
  await reportRow(h.page, 'Storage layer').click();
  const detail = reportDetail(h.page);
  await detail.getByRole('heading', { level: 1, name: 'Storage layer' }).waitFor();
  await detail.getByText('Declared complete by Claude. This is a claim by the model, not proof that the work was done or tested.').waitFor();
  await detail.getByRole('region', { name: 'Full report text' }).getByText('## Implementation Report').waitFor();
  // Opening a report is reading it.
  await until('the report to be marked read', async () => (await reportsOf(h, scene.project.id)).find((r) => r.id === report.id)?.read === true);
  evidence('A16', `typing "Wrap up the storage layer ..." in the terminal produced one report (marker, declared complete, session ${scene.session.sessionId.slice(0, 8)}); a turn without the marker made no report but was kept as an "other message"; partial and blocked were captured as declared; the queue row and the report page show the declaration, the project and the full text`);
});

scenario('[A17] The report remains linked to the correct project', async () => {
  const h = await launchApp();
  const alpha = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  const beta = await sceneWithSession(h, 'Beta', { conversations: [conversationUrl(B)] });
  await selectProject(h.page, 'Beta'); // Beta is on screen while Alpha's Claude finishes

  const report = await finishTask(h, alpha, 'Alpha storage');
  expect(report).toMatchObject({ projectId: alpha.project.id, projectName: 'Alpha', sessionKey: alpha.session.key });
  expect(await reportsOf(h, beta.project.id)).toEqual([]);
  const delivery = await latestDelivery(h, report.id);
  expect(delivery.projectId).toBe(alpha.project.id);

  // The sidebar counts it for Alpha only; the report page names Alpha and Alpha's session, and the links lead there.
  await projectRowWith(h.page, 'Alpha', '1 report waiting for handoff').waitFor();
  expect(await projectRow(h.page, 'Beta').getAttribute('aria-label')).not.toContain('report');
  await openReport(h.page, 'Alpha storage');
  const facts = reportDetail(h.page).getByRole('definition');
  await reportDetail(h.page).getByRole('button', { name: 'Alpha', exact: true }).waitFor();
  await reportDetail(h.page).getByRole('button', { name: `Open session ${alpha.session.sessionId.slice(0, 8)}` }).waitFor();
  void facts;
  await reportDetail(h.page).getByRole('button', { name: 'Alpha', exact: true }).click();
  await h.page.getByRole('heading', { level: 1, name: 'Alpha' }).waitFor();

  // The queue filter agrees.
  await openReports(h.page);
  await h.page.getByRole('button', { name: 'Project' }).first().click();
  await h.page.getByRole('option', { name: 'Beta' }).click();
  await h.page.getByText('No reports match these filters.').waitFor();
  await h.page.getByRole('button', { name: 'Clear filters' }).click();
  await reportRow(h.page, 'Alpha storage').waitFor();

  // The link is to the project, not to its name: after a rename the report's project button still leads to the same project.
  await h.api.call('projects.update', { params: { id: alpha.project.id }, body: { name: 'Alpha renamed' } });
  await h.page.getByRole('heading', { level: 1, name: 'Alpha renamed' }).waitFor();
  expect((await reportsOf(h, alpha.project.id))[0].projectId).toBe(alpha.project.id);
  expect((await latestDelivery(h, report.id)).projectId).toBe(alpha.project.id);
  await openReport(h.page, 'Alpha storage');
  await reportDetail(h.page).getByRole('button', { name: /^Alpha/ }).first().click();
  await h.page.getByRole('heading', { level: 1, name: 'Alpha renamed' }).waitFor();
  evidence('A17', `Alpha's Claude finished while Beta was selected: the report is stored under Alpha (project id ${alpha.project.id.slice(0, 12)}) and Alpha's session; Beta has none; the sidebar counted it on Alpha's row only; the report page's project and session links lead to Alpha; filtering by Beta shows nothing; after renaming Alpha the report still belongs to it (same project id) and its project button leads there`);
  void beta;
});

scenario('[A18] The report can be copied in full (byte for byte)', async () => {
  const h = await launchApp();
  const scene = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  // A title with characters beyond ASCII, because that is where copying goes wrong.
  const task = 'Prüfung des Schemas ✓ 日本語 😀';
  const report = await finishTask(h, scene, task);
  const stored = await fullReport(h, report.id);
  expect(stored.body).toContain(task);

  // "Copy full report text" puts exactly the stored report on the system clipboard.
  await writeClipboard(h.app, 'something else that must be replaced');
  await openReport(h.page, task);
  await reportDetail(h.page).getByRole('button', { name: 'Copy full report text' }).click();
  await until('the clipboard to hold the report', async () => (await readClipboard(h.app)) !== 'something else that must be replaced');
  const copied = await readClipboard(h.app);
  expect(Buffer.from(copied, 'utf8').equals(Buffer.from(stored.body, 'utf8'))).toBe(true);
  expect(sha256(copied)).toBe(sha256(stored.body));

  // "Copy and open" puts the whole message for ChatGPT on the clipboard: the report between its fences, unedited. (The window
  // goes to the workspace so that the ChatGPT pane is on screen when the conversation opens.)
  await writeClipboard(h.app, 'something else again');
  await handoffCard(h.page).getByRole('button', { name: 'Copy and open' }).click();
  await until('the message to be on the clipboard', async () => (await readClipboard(h.app)).startsWith('Project: Alpha'));
  const message = await readClipboard(h.app);
  const delivery = await latestDelivery(h, report.id);
  const prepared = await h.api.call('deliveries.prepare', { params: { id: delivery.id } });
  expect(prepared.partCount).toBe(1);
  expect(Buffer.from(message, 'utf8').equals(Buffer.from(prepared.message, 'utf8'))).toBe(true);
  expect(message).toContain(`<<<MINI-SUMMA REPORT ${report.id} BEGIN>>>\n${stored.body}\n<<<MINI-SUMMA REPORT ${report.id} END>>>`);
  evidence('A18', `report "${task}": "Copy full report text" left ${Buffer.byteLength(copied)} bytes on the system clipboard, identical byte for byte (sha256 ${sha256(copied).slice(0, 12)}) to the stored report; "Copy and open" left the whole prepared message (${Buffer.byteLength(message)} bytes) with the report verbatim between its fences`);
});

scenario('[A18] A long report is copied in numbered parts that rebuild the message exactly', async () => {
  const h = await launchApp();
  const scene = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  // The fake can only write a marked report of a few hundred characters, so the long one is a final message without the marker
  // that the person makes a report of ("Make this a report"): the same report record, the same handoff.
  const line = (n: number) => `Line ${String(n).padStart(4, '0')}: the importer handles unicode (éèê ✓ 日本) and keeps going.`;
  const body = Array.from({ length: 300 }, (_, i) => line(i + 1)).join('\n');
  const stream = await observe(h, scene.session.key);
  await stream.type(`${directive.say(body).replace(/\n/g, ' \n')}`, { paste: true });
  const candidate = await until('the long unmarked message to be kept', async () => (await h.api.call('candidates.list', { query: { projectId: scene.project.id } }))[0] ?? null, { timeout: 30_000 });
  expect(candidate.body.length).toBeGreaterThan(20_000);
  const report = await h.api.call('candidates.promote', { params: { id: candidate.id } });
  expect(report.body).toBe(candidate.body);

  await openReport(h.page, report.taskTitle);
  const card = handoffCard(h.page);
  await card.getByText(/This message is long, so it has \d+ parts/).waitFor();
  const delivery = await latestDelivery(h, report.id);
  const prepared = await h.api.call('deliveries.prepare', { params: { id: delivery.id } });
  const total = prepared.partCount;
  expect(total).toBeGreaterThanOrEqual(2);

  // "Copy part 1 of N and open" (the window then shows the workspace), then each remaining part from the report page.
  const clipboardParts: string[] = [];
  await card.getByRole('button', { name: `Copy part 1 of ${total} and open` }).click();
  await until('part 1 on the clipboard', async () => (await readClipboard(h.app)).includes(`part 1 of ${total}]`));
  clipboardParts.push(await readClipboard(h.app));
  await openReport(h.page, report.taskTitle);
  for (let part = 2; part <= total; part += 1) {
    await handoffCard(h.page).getByRole('button', { name: `Copy part ${part} of ${total}`, exact: true }).click();
    await until(`part ${part} on the clipboard`, async () => (await readClipboard(h.app)).includes(`part ${part} of ${total}]`));
    clipboardParts.push(await readClipboard(h.app));
  }
  for (let i = 0; i < total; i += 1) {
    const expected = await h.api.call('deliveries.part', { params: { id: delivery.id, index: String(i + 1) } });
    expect(Buffer.from(clipboardParts[i], 'utf8').equals(Buffer.from(expected.text, 'utf8')), `part ${i + 1} on the clipboard differs from the part the core holds`).toBe(true);
    expect(sha256(clipboardParts[i])).toBe(expected.sha256);
    expect(clipboardParts[i].length).toBeLessThanOrEqual(12_000);
  }

  // Strip each part's header and footer: what is left, joined, is the message, and the message holds the report exactly.
  const payloads = clipboardParts.map((text) => text.replace(/^\[Mini-Summa report [^\]]*, part \d+ of \d+\]\n/, '').replace(/\n\[End of part \d+ of \d+\.[^\]]*\]$/, ''));
  const rebuilt = payloads.join('');
  expect(Buffer.from(rebuilt, 'utf8').equals(Buffer.from(prepared.message, 'utf8'))).toBe(true);
  expect(rebuilt).toContain(`<<<MINI-SUMMA REPORT ${report.id} BEGIN>>>\n${report.body}\n<<<MINI-SUMMA REPORT ${report.id} END>>>`);
  const after = await h.api.call('deliveries.get', { params: { id: delivery.id } });
  expect(after.parts.every((p) => p.copiedAt !== null)).toBe(true);
  expect(after.state).not.toBe('user_confirmed_sent'); // copying all of it is still not sending it
  evidence('A18', `a ${report.body.length}-character report was offered as ${total} parts; each "Copy part k of ${total}" put exactly that part (header, payload, footer) on the clipboard, matching the core's sha256; the parts' payloads joined are byte-identical to the prepared message, which holds the whole report between its fences; copying every part did not mark the delivery as sent (state ${after.state})`);
});

scenario('[A19] The correct ChatGPT conversation can be opened for handoff', async () => {
  const h = await launchApp();
  h.standIn.name(C1, 'Stand-in: C first');
  h.standIn.name(C2, 'Stand-in: C second (preferred)');
  // Two conversations; the SECOND is the preferred one. The first must not be what the report goes to.
  const scene = await sceneWithSession(h, 'Chess', { conversations: [conversationUrl(C1), conversationUrl(C2)], preferred: 1 });
  const report = await finishTask(h, scene, 'Opening book');
  const delivery = await latestDelivery(h, report.id);
  expect(delivery.destination).toMatchObject({ url: conversationUrl(C2), resolvedFrom: 'project_preferred', conversationId: scene.conversations[1].id });

  await openReport(h.page, 'Opening book');
  const card = handoffCard(h.page);
  await card.getByLabel('Destination').getByText(conversationUrl(C2), { exact: true }).waitFor();
  await card.getByText("Chosen because it is the project's preferred conversation.").waitFor();
  await card.getByText(/It does not follow the open tab, the selected project or later changes/).waitFor();

  // Copy and open: the clipboard holds the message and the embedded view navigates to the frozen destination, nothing else.
  const mark = h.standIn.mark();
  await card.getByRole('button', { name: 'Copy and open' }).click();
  await until('the embedded view to show the preferred conversation', async () => {
    const view = await chatgptView(h.app);
    return view?.url === conversationUrl(C2) && !view.loading && view.title === 'Stand-in: C second (preferred)';
  });
  await openReport(h.page, 'Opening book');
  await handoffCard(h.page).getByText('Awaiting your send', { exact: true }).waitFor();
  expect(h.standIn.pathsSince(mark)).toEqual([`/c/${C2}`]);
  expect(h.standIn.requests.some((r) => r.path === `/c/${C1}`)).toBe(false);
  const clip = await readClipboard(h.app);
  expect(clip).toContain('Project: Chess');
  expect(clip).toContain('Task: Opening book');
  const after = await latestDelivery(h, report.id);
  expect(after.state).toBe('awaiting_user_send'); // copied and opened, and waiting for the person: not "sent"
  // Mini-Summa did not type or paste into the page, and did not submit it.
  const page = await standInPageState(h.app);
  expect(page).toEqual({ events: [], composer: '' });
  evidence('A19', `project with two conversations, the second preferred: the report was frozen to ${conversationUrl(C2)} ("preferred conversation"), "Copy and open" navigated the embedded view there (title "Stand-in: C second (preferred)"), the stand-in saw exactly GET /c/${C2} and never the first conversation, the clipboard held the message, the delivery waits for the person (awaiting_user_send), and the page's composer stayed empty with no input events`);
});

scenario('[A20] A report cannot be accidentally routed to another project\'s mapped conversation', async () => {
  const h = await launchApp();
  h.standIn.name(A, 'Stand-in: A');
  h.standIn.name(B, 'Stand-in: B');
  const alpha = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  const beta = await sceneWithSession(h, 'Beta', { conversations: [conversationUrl(B)] });

  // Beta is selected, and its conversation is the page in front, focused, when Alpha's Claude finishes.
  await selectProject(h.page, 'Beta');
  await until('Beta\'s conversation to be the page in front', async () => (await chatgptView(h.app))?.url === conversationUrl(B));
  const report = await finishTask(h, alpha, 'Alpha release notes');
  const delivery = await latestDelivery(h, report.id);
  expect(delivery.destination).toMatchObject({ url: conversationUrl(A), conversationId: alpha.conversations[0].id });
  expect(delivery.projectId).toBe(alpha.project.id);
  expect(await h.api.call('deliveries.list', { query: { projectId: beta.project.id } })).toEqual([]);
  expect((await chatgptView(h.app))?.url).toBe(conversationUrl(B)); // capturing a report did not move the page in front

  // The screen offers only Alpha's own conversations when the destination is to be changed.
  await openReport(h.page, 'Alpha release notes');
  const card = handoffCard(h.page);
  await card.getByRole('button', { name: 'Change destination' }).first().click();
  const choices = h.page.getByRole('dialog', { name: 'Change where this report goes?' }).getByRole('radiogroup', { name: 'Conversations of this project' });
  await choices.getByRole('radio').first().waitFor();
  expect(await choices.getByRole('radio').count()).toBe(1);
  expect(await choices.getByText(conversationUrl(B)).count()).toBe(0);
  await h.page.getByRole('dialog', { name: 'Change where this report goes?' }).getByRole('button', { name: 'Cancel' }).click();

  // Handoff while Beta is still the selected project: Alpha's text, Alpha's conversation.
  const mark = h.standIn.mark();
  await card.getByRole('button', { name: 'Copy and open' }).click();
  await until('the view to show Alpha\'s conversation', async () => (await chatgptView(h.app))?.url === conversationUrl(A));
  const clip = await readClipboard(h.app);
  expect(clip).toContain('Project: Alpha');
  expect(clip).toContain('Task: Alpha release notes');
  expect(clip).not.toContain('Project: Beta');
  expect(h.standIn.pathsSince(mark)).toEqual([`/c/${A}`]);

  // Later changes to the project do not retarget what already exists: Alpha prefers a new conversation, the delivery keeps its own.
  const extra = uuidOf('a2');
  await h.api.call('conversations.add', { params: { id: alpha.project.id }, body: { url: conversationUrl(extra), makePreferred: true } });
  expect((await latestDelivery(h, report.id)).destination?.url).toBe(conversationUrl(A));

  // Only an explicit action re-points a delivery, and it leaves a mark in the history (even for another project's conversation).
  const events = (await h.api.call('deliveries.get', { params: { id: delivery.id } })).events;
  expect(events.filter((e) => e.type === 'destination_changed')).toEqual([]);
  const moved = await h.api.call('deliveries.setDestination', { params: { id: delivery.id }, body: { conversationId: beta.conversations[0].id } });
  expect(moved.destination?.url).toBe(conversationUrl(B));
  const changed = (await h.api.call('deliveries.get', { params: { id: delivery.id } })).events.filter((e) => e.type === 'destination_changed');
  expect(changed).toHaveLength(1);
  expect(changed[0].detail).toMatchObject({ otherProject: true });
  evidence('A20', `Beta selected with its conversation in front: Alpha's report was frozen to Alpha's conversation and nothing was created for Beta; "Change destination" listed only Alpha's conversation; "Copy and open" left Alpha's text on the clipboard and navigated to ${conversationUrl(A)} (stand-in saw only GET /c/${A}); adding a new preferred conversation to Alpha did not retarget the delivery; re-pointing is only possible by an explicit action (API; the window offers none across projects) and is recorded as destination_changed with otherProject:true`);
});

// startSession and projectRow are shared helpers used by sibling files; keep the imports honest.
void startSession;
void createProject;
void reportList;
