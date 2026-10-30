// X05: the whole loop without leaving the workspace. Claude finishes a task; a strip above the two panes offers "Copy and open"; the
// message is on the clipboard and the mapped conversation is in the pane right below; after the person has pasted and sent it in
// ChatGPT, "I sent it" is in the same place. Before the person says so, nothing says it was sent.
//
// (The paste and the Send are the person's, in ChatGPT; this suite never types into the stand-in page. What it checks is what
// Mini-Summa shows, copies and records, and where the native ChatGPT view is while the strip changes the layout.)
import { expect } from 'vitest';
import type { Rect } from '@minisumma/shared';
import { launchApp } from '../helpers/app.ts';
import type { AppHandle } from '../helpers/app.ts';
import { latestDelivery } from '../helpers/core.ts';
import { evidence } from '../helpers/evidence.ts';
import { directive } from '../helpers/fake-claude.ts';
import { finishTask, sceneWithSession } from '../helpers/flow.ts';
import { arrangement, box, viewMatchesSlot } from '../helpers/layout.ts';
import { chatgptView, readClipboard, setWindowSize, standInPageState, writeClipboard } from '../helpers/main-process.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';
import { observe } from '../helpers/terminal.ts';
import { handoffCard, handoffStrip, openReports, projectsNav, reportRow, selectProject } from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

const A = uuidOf('a');
const LONG_TITLE = 'Replace the legacy session store with the new append-only event log and migrate every existing user before the next release';

/** The strip sits above the panes, inside the page, and the native ChatGPT view sits below it exactly over its slot. */
async function expectViewBelowStrip(h: AppHandle, what: string): Promise<{ strip: Rect; slot: Rect }> {
  const { slot, native } = await viewMatchesSlot(h);
  const strip = await box(handoffStrip(h.page));
  expect(strip.y + strip.height, `${what}: the strip must end where the panes begin`).toBeLessThanOrEqual(slot.y + 1.5);
  expect(native.y, `${what}: the native view must start below the strip`).toBeGreaterThanOrEqual(strip.y + strip.height - 1.5);
  const window = await h.page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(window.scroll, `${what}: no horizontal scrolling of the page`).toBeLessThanOrEqual(window.width);
  expect(strip.x + strip.width, `${what}: the strip stays inside the window`).toBeLessThanOrEqual(window.width + 1);
  return { strip, slot };
}

scenario('[X05] A report is handed over and confirmed from the workspace, without going back to Reports', async () => {
  const h = await launchApp();
  h.standIn.name(A, 'Stand-in: Alpha conversation');
  const scene = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  await selectProject(h.page, 'Alpha');
  await until('Alpha\'s conversation to be in front', async () => (await chatgptView(h.app))?.url === conversationUrl(A));
  const strip = handoffStrip(h.page);
  expect(await strip.count(), 'with no report waiting there is no strip').toBe(0);
  await viewMatchesSlot(h);

  // --- Claude finishes a task. The strip appears in the workspace the person is looking at, and the view moves out of its way.
  const report = await finishTask(h, scene, 'Strip the legacy endpoints');
  await strip.waitFor();
  const delivery = await latestDelivery(h, report.id);
  expect(delivery).toMatchObject({ state: 'destination_unverified', destination: { url: conversationUrl(A), conversationId: scene.conversations[0].id } });
  const destinationTitle = delivery.destination!.title;
  expect(await strip.getAttribute('aria-label')).toBe('Report handoff: Strip the legacy endpoints');
  await strip.getByText('Report ready: Strip the legacy endpoints', { exact: true }).waitFor();
  // A conversation that was just mapped is not verified yet; the strip says so and does not make it a reason to hold back.
  await strip.getByText(`Goes to ${destinationTitle}, which is not verified yet.`, { exact: true }).waitFor();
  expect(await strip.getByRole('button').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))).toEqual(['Copy and open', 'Open report']);
  expect(await strip.innerText()).not.toMatch(/was sent|has been sent|delivered|\bI sent it\b/);
  const ready = await expectViewBelowStrip(h, 'strip showing a ready report');
  expect(ready.slot.y).toBeGreaterThan(0);

  // --- "Copy and open", in the strip: the message is on the clipboard, the conversation is in the pane, and the strip waits.
  await writeClipboard(h.app, 'something else that must be replaced');
  const mark = h.standIn.mark();
  await strip.getByRole('button', { name: 'Copy and open' }).click();
  await until('the clipboard to hold the report message', async () => (await readClipboard(h.app)).includes('Task: Strip the legacy endpoints'));
  await until('the embedded view to show the mapped conversation', async () => {
    const view = await chatgptView(h.app);
    return view?.url === conversationUrl(A) && !view.loading && view.title === 'Stand-in: Alpha conversation';
  });
  await until('the delivery to wait for the person', async () => (await latestDelivery(h, report.id)).state === 'awaiting_user_send');
  const prepared = await h.api.call('deliveries.prepare', { params: { id: delivery.id } });
  expect(await readClipboard(h.app)).toBe(prepared.message);
  expect(prepared.message).toContain(`<<<MINI-SUMMA REPORT ${report.id} BEGIN>>>`);
  await strip.getByText(`Waiting for you to send: Strip the legacy endpoints to ${destinationTitle}.`, { exact: true }).waitFor();
  await strip.getByText('It is not marked as sent until you press I sent it.', { exact: true }).waitFor();
  await strip.getByText('The message is on your clipboard.', { exact: true }).waitFor();
  expect(await strip.getByRole('button').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))).toEqual(['I sent it', 'Copy again', 'Open conversation', 'Not sure', 'Open report']);
  // The loop never left the workspace, and the core still says "waiting", not "sent".
  await h.page.getByRole('heading', { level: 1, name: 'Alpha' }).waitFor();
  expect(await h.page.getByRole('region', { name: 'Reports', exact: true }).count()).toBe(0);
  expect(await projectsNav(h.page).isVisible()).toBe(true);
  expect((await latestDelivery(h, report.id)).state).not.toBe('user_confirmed_sent');
  // Mini-Summa did not type, paste or submit into the page; the only request was the navigation.
  expect(h.standIn.since(mark).map((r) => `${r.method} ${r.path}`).filter((r) => r !== `GET /c/${A}`)).toEqual([]);
  expect(await standInPageState(h.app)).toEqual({ events: [], composer: '' });
  await expectViewBelowStrip(h, 'strip waiting for the send');

  // --- The person pastes and sends in ChatGPT (not done here), comes back to the strip and says so, with the keyboard.
  const sent = strip.getByRole('button', { name: 'I sent it', exact: true });
  await sent.focus();
  await h.page.keyboard.press('Enter');
  await until('the delivery to become user_confirmed_sent', async () => (await latestDelivery(h, report.id)).state === 'user_confirmed_sent');
  await strip.waitFor({ state: 'detached' });
  await viewMatchesSlot(h);
  const after = await latestDelivery(h, report.id);
  expect(after.destination).toEqual(delivery.destination); // frozen, as ever
  const events = (await h.api.call('deliveries.get', { params: { id: delivery.id } })).events.map((e) => e.type);
  expect(events.filter((t) => t === 'confirmed_sent')).toHaveLength(1);
  expect(events.indexOf('part_copied')).toBeLessThan(events.indexOf('confirmed_sent'));

  // --- The queue and the card agree with the strip.
  await openReports(h.page);
  await until('the queue to say what the person said', async () => ((await reportRow(h.page, 'Strip the legacy endpoints').getAttribute('aria-label')) ?? '').includes('Review awaiting you'));
  await reportRow(h.page, 'Strip the legacy endpoints').click();
  await handoffCard(h.page).getByRole('heading', { level: 3, name: /^You confirmed it was sent/ }).waitFor();
  expect(h.standIn.submissions()).toEqual([]);
  evidence('X05', `Claude finished "Strip the legacy endpoints" while Alpha was open: a strip "Report ready: ..." appeared above the panes (Copy and open, Open report) and the native view moved below it (view ${Math.round(ready.slot.width)}x${Math.round(ready.slot.height)} equals its slot); "Copy and open" in the strip left the whole message on the clipboard, loaded ${conversationUrl(A)} in the embedded view (the stand-in saw only that GET, the composer stayed empty) and the delivery became awaiting_user_send while the strip said "Waiting for you to send ... It is not marked as sent until you press I sent it."; "I sent it" (keyboard, Enter) made it user_confirmed_sent with one confirmed_sent event after the part_copied one, the strip disappeared, and the queue ("Review awaiting you") and the card ("You confirmed it was sent") agreed; the window never left the workspace until the person opened Reports to look`);
});

scenario('[X05] The strip fits portrait and landscape, a collapsed sidebar, several reports and a very long title', async () => {
  const h = await launchApp({ size: { width: 1400, height: 850 } });
  const scene = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  await selectProject(h.page, 'Alpha');
  const strip = handoffStrip(h.page);
  await finishTask(h, scene, 'First report');
  const long = await finishTask(h, scene, LONG_TITLE);
  await until('the strip to show the newest report', async () => ((await strip.getAttribute('aria-label').catch(() => null)) ?? '').includes('Replace the legacy session store'));
  await strip.getByRole('button', { name: /^\+1 more\./ }).waitFor(); // the other report is one link away

  // Landscape.
  expect((await arrangement(h.page)).layout).toBe('side-by-side');
  await expectViewBelowStrip(h, 'landscape');

  // The title is cut by the layout, and whole in the tooltip and the accessible name.
  const headline = strip.getByText(`Report ready: ${LONG_TITLE}`, { exact: true });
  expect(await headline.getAttribute('title')).toBe(`Report ready: ${LONG_TITLE}`);
  expect(await strip.getAttribute('aria-label')).toBe(`Report handoff: ${LONG_TITLE}`);
  expect((await box(strip)).height, 'a long title must not make the strip tall').toBeLessThan(110);

  // Portrait: the panes stack, the strip wraps its buttons under the text, and the view still sits over its slot below the strip.
  await setWindowSize(h.app, 1000, 1300);
  await until('the panes to stack', async () => (await arrangement(h.page)).layout === 'stacked');
  const portrait = await expectViewBelowStrip(h, 'portrait');
  for (const name of ['Copy and open', 'Open report']) expect((await box(strip.getByRole('button', { name }))).x, `${name} is inside the window`).toBeLessThan(1000);

  // The sidebar collapsed to its rail: the strip takes the width, and the view follows.
  await setWindowSize(h.app, 1400, 850);
  await until('the panes to sit side by side', async () => (await arrangement(h.page)).layout === 'side-by-side');
  await h.page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await h.page.getByRole('button', { name: 'Expand sidebar' }).waitFor();
  const collapsed = await expectViewBelowStrip(h, 'collapsed sidebar');
  expect((await box(strip)).width).toBeGreaterThan(portrait.strip.width);

  // The next report takes over after this one is handled: "Not sure" is the card's to untangle, so it leaves the strip.
  await strip.getByRole('button', { name: 'Copy and open' }).click();
  await until('the long report to wait for the person', async () => (await latestDelivery(h, long.id)).state === 'awaiting_user_send');
  await strip.getByText(/^Waiting for you to send: Replace the legacy session store/).waitFor();
  await strip.getByRole('button', { name: 'Not sure', exact: true }).click();
  await until('the delivery to be uncertain', async () => (await latestDelivery(h, long.id)).state === 'delivery_uncertain');
  await until('the other report to take its place', async () => ((await strip.getAttribute('aria-label').catch(() => null)) ?? '') === 'Report handoff: First report');
  expect(await strip.getByRole('button', { name: /more/ }).count()).toBe(0);
  await expectViewBelowStrip(h, 'next report');
  evidence('X05', `the strip kept the native view under it in landscape (strip ${Math.round(collapsed.strip.width)}px wide with the sidebar collapsed), in portrait (${Math.round(portrait.strip.height)}px tall, buttons under the text, no horizontal scrolling) and with a ${LONG_TITLE.length}-character title (cut to two lines, whole in its tooltip and accessible name, "+1 more" for the other report); "Not sure" took the long report out of the strip and the other one took its place`);
});

scenario('[X05] A long report is copied part by part from the strip, and "I sent it" comes after the last part', async () => {
  const h = await launchApp();
  const scene = await sceneWithSession(h, 'Alpha', { conversations: [conversationUrl(A)] });
  await selectProject(h.page, 'Alpha');
  // The fake can only write a marked report of a few hundred characters, so the long one is a final message without the marker that the
  // person makes a report of: the same report record, the same handoff (as in A18).
  const body = Array.from({ length: 300 }, (_, i) => `Line ${String(i + 1).padStart(4, '0')}: the importer handles unicode (éèê ✓ 日本) and keeps going.`).join('\n');
  const stream = await observe(h, scene.session.key);
  await stream.type(`${directive.say(body).replace(/\n/g, ' \n')}`, { paste: true });
  const candidate = await until('the long unmarked message to be kept', async () => (await h.api.call('candidates.list', { query: { projectId: scene.project.id } }))[0] ?? null, { timeout: 30_000 });
  const report = await h.api.call('candidates.promote', { params: { id: candidate.id } });

  const strip = handoffStrip(h.page);
  await strip.waitFor();
  expect(await strip.getAttribute('aria-label')).toBe(`Report handoff: ${report.taskTitle}`);
  const delivery = await latestDelivery(h, report.id);
  // Showing the strip did not prepare anything: that is learned when the first part is copied.
  expect(delivery.parts).toEqual([]);
  expect(await strip.getByRole('button', { name: 'Copy and open', exact: true }).count()).toBe(1);

  await strip.getByRole('button', { name: 'Copy and open', exact: true }).click();
  const next = strip.getByRole('button', { name: /^Copy part 2 of \d+ and open$/ });
  await next.waitFor();
  const total = Number(/of (\d+) and open/.exec((await next.innerText()).trim())![1]);
  expect(total).toBeGreaterThanOrEqual(2);
  await strip.getByText(`Part 1 of ${total} is on your clipboard.`, { exact: true }).waitFor();
  expect(await strip.getByRole('button', { name: 'I sent it' }).count(), '"I sent it" waits for the last part').toBe(0);
  const onClipboard: string[] = [await readClipboard(h.app)];
  for (let part = 2; part <= total; part += 1) {
    await strip.getByText(`${part - 1} of ${total} parts are copied. Part ${part} is next. It is not marked as sent until you press I sent it.`, { exact: true }).waitFor();
    await strip.getByRole('button', { name: `Copy part ${part} of ${total} and open`, exact: true }).click();
    await until(`part ${part} on the clipboard`, async () => (await readClipboard(h.app)).includes(`part ${part} of ${total}]`));
    onClipboard.push(await readClipboard(h.app));
  }
  await strip.getByRole('button', { name: 'I sent it', exact: true }).waitFor();
  for (let i = 0; i < total; i += 1) {
    const expected = await h.api.call('deliveries.part', { params: { id: delivery.id, index: String(i + 1) } });
    expect(Buffer.from(onClipboard[i], 'utf8').equals(Buffer.from(expected.text, 'utf8')), `part ${i + 1} on the clipboard differs from the part the core holds`).toBe(true);
  }
  const copied = await latestDelivery(h, report.id);
  expect(copied.state).toBe('awaiting_user_send'); // every part copied, still not sent
  expect(copied.parts.every((p) => p.copiedAt !== null)).toBe(true);
  await viewMatchesSlot(h);
  await strip.getByRole('button', { name: 'I sent it', exact: true }).click();
  await until('the delivery to become user_confirmed_sent', async () => (await latestDelivery(h, report.id)).state === 'user_confirmed_sent');
  await strip.waitFor({ state: 'detached' });
  expect(h.standIn.submissions()).toEqual([]);
  evidence('X05', `a ${report.body.length}-character report (made a report from an unmarked message) showed a strip with "Copy and open" and no prepared message (showing it prepared nothing); each press copied the next part exactly as the core holds it (${total} parts, "Part k of ${total} is on your clipboard", "k of ${total} parts are copied"), "I sent it" appeared only after the last part, and after it the delivery was user_confirmed_sent`);
}, { timeout: 150_000 });
