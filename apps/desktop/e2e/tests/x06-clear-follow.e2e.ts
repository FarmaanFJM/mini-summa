// X06: Claude replaces the conversation INSIDE a running terminal (/clear). The terminal stays managed under a new session id; the old
// session is history that names its successor. The Claude pane follows: the person ends on the new session's tab, in the same terminal
// (same process, same screen), typing still reaches Claude, the old session is kept as ended history in the Sessions menu, and a restart
// reopens on the new session. (The fake Claude CLI does what the real CLI 2.1.314 does: SessionEnd "clear", SessionStart with a new id,
// the same process listed under it.)
import { expect } from 'vitest';
import { launchApp } from '../helpers/app.ts';
import { acceptsInput, createProject, waitForSession } from '../helpers/core.ts';
import { evidence } from '../helpers/evidence.ts';
import { readReceived, typedCommand } from '../helpers/fake-claude.ts';
import { scenario } from '../helpers/scenario.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';
import { claudePane, screenText, typeLikeAPerson, waitForScreen } from '../helpers/terminal.ts';
import { claudeTabs, selectProject, startSessionInUi } from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

const A = uuidOf('a');
const tag = (key: string): string => key.split('|')[1].slice(0, 8);

scenario('[X06] After /clear inside a managed terminal the Claude pane follows to the new session, and a restart reopens on it', async () => {
  const h = await launchApp();
  const alpha = await createProject(h, 'Alpha', { conversations: [conversationUrl(A)] });
  await selectProject(h.page, 'Alpha');

  // --- A session started the person's way, and one message in it (so that the conversation has history).
  await startSessionInUi(h.page);
  const [old] = await until('one managed session', async () => {
    const list = await h.api.call('sessions.list');
    return list.length === 1 ? list : null;
  });
  await waitForSession(h, old.key, (s) => s.state !== 'unknown', 'the session to leave Starting');
  await waitForScreen(h.page, 'for shortcuts');
  const before = 'before the clear'; // short: a long echo wraps, and a wrapped line cannot be looked for whole
  await typeLikeAPerson(h.page, before);
  await waitForScreen(h.page, `Echo: ${before}`);
  const oldView = await h.api.call('sessions.get', { params: { key: old.key } });
  expect(oldView).toMatchObject({ origin: 'managed', availability: 'live', projectId: alpha.project.id });
  const claude = claudePane(h.page);
  await claude.getByRole('tab', { name: new RegExp(`^Session ${tag(old.key)}, managed, Linux\\.`) }).waitFor();
  expect(await claudeTabs(h.page).count()).toBe(1);

  // --- The person types /clear in the terminal. Claude replaces the conversation inside the same process.
  // From here on the page records every moment a "This session ended" notice is put into it, even one that is gone a moment later:
  // the pane must go from the old session to the new one without ever telling the person that the session ended.
  await h.page.evaluate(() => {
    const w = window as unknown as { __endedNotices?: string[] };
    w.__endedNotices = [];
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (/This session ended/.test(node.textContent ?? '')) w.__endedNotices!.push((node.textContent ?? '').slice(0, 100));
    }).observe(document.body, { childList: true, subtree: true });
  });
  await typeLikeAPerson(h.page, typedCommand.clear);
  const { replaced, fresh } = await until('the terminal to go on under a new session', async () => {
    const list = await h.api.call('sessions.list', { query: { includeEnded: true } });
    const o = list.find((s) => s.key === old.key);
    const n = o?.replacedBy ? list.find((s) => s.key === o.replacedBy) : undefined;
    return o && n && n.availability === 'live' ? { replaced: o, fresh: n } : null;
  }, { timeout: 30_000 });
  expect(fresh.key).not.toBe(old.key);
  expect(fresh).toMatchObject({ origin: 'managed', availability: 'live', projectId: alpha.project.id });
  expect(fresh.pid, 'the same process, still running').toBe(oldView.pid);
  expect(replaced).toMatchObject({ origin: 'managed', replacedBy: fresh.key });
  expect(['ended', 'resumable']).toContain(replaced.availability);

  // --- The pane: the new session's tab, selected and running; the old tab is gone; no notice that anything ended.
  const freshTab = claude.getByRole('tab', { name: new RegExp(`^Session ${tag(fresh.key)}, managed, Linux\\.`) });
  await freshTab.waitFor();
  await until('the new tab to be selected', async () => (await freshTab.getAttribute('aria-selected')) === 'true');
  expect(await freshTab.getAttribute('aria-label') ?? await freshTab.getAttribute('title') ?? '').not.toMatch(/Session ended/);
  expect(await claudeTabs(h.page).count(), 'one tab for the one terminal').toBe(1);
  expect(await claude.getByRole('tab', { name: new RegExp(`^Session ${tag(old.key)},`) }).count()).toBe(0);
  expect(await claude.getByRole('status').filter({ hasText: 'This session ended' }).count()).toBe(0);
  expect(await h.page.evaluate(() => (window as unknown as { __endedNotices: string[] }).__endedNotices), 'no moment of "This session ended" while the pane moved on').toEqual([]);
  await claude.getByText(/Input goes to:/).waitFor();
  expect(await claude.locator('.ms-input').innerText()).toContain(`Session ${tag(fresh.key)}`);

  // --- The same terminal: the screen still shows what came before, and what Claude printed for the new conversation.
  const screen = await waitForScreen(h.page, `session: ${fresh.sessionId}`);
  expect(screen).toContain(`Echo: ${before}`);
  expect(await screenText(h.page)).toContain('Conversation cleared');

  // --- Typing still reaches the process, and the answer comes back on the same screen.
  const after = 'after the clear';
  await typeLikeAPerson(h.page, after);
  await waitForScreen(h.page, `Echo: ${after}`);
  await until('the new session to have received it', () => readReceived(h.sandbox.fakeState, fresh.sessionId).map((r) => r.text).includes(after));
  expect(readReceived(h.sandbox.fakeState, old.sessionId).map((r) => r.text)).toEqual([before]); // the old session got nothing more

  // --- The old session is kept as ended history, in the Sessions menu.
  await claude.getByRole('button', { name: 'Sessions', exact: true }).click();
  const item = h.page.getByRole('menuitem', { name: `${tag(old.key)}, managed, Session ended, went on as ${tag(fresh.key)}` });
  await item.waitFor();
  await h.page.keyboard.press('Escape');
  await h.page.getByRole('menu').waitFor({ state: 'hidden' });

  // --- What the window remembers moved to the new session, in the core.
  await until('the core to remember the new session as the project\'s tab', async () => (await h.api.call('settings.get')).ui?.perProject?.[alpha.project.id]?.sessionKey === fresh.key, { timeout: 15_000 });
  // The turn the person started in the new session is over (a prompt was submitted to it), so it has a conversation to resume.
  await waitForSession(h, fresh.key, (s) => acceptsInput(s), 'the new session to be done with the turn after the clear');

  // --- A restart on the same data directory: the pane reopens on the new session (as ended, with its Resume), not on the old one.
  expect((await h.quit()).code).toBe(0);
  const h2 = await launchApp({ sandbox: h.sandbox, standIn: h.standIn });
  await selectProject(h2.page, 'Alpha');
  const claude2 = claudePane(h2.page);
  const reopened = claude2.getByRole('tab', { name: new RegExp(`^Session ${tag(fresh.key)}, managed, Linux\\. Session ended`) });
  await reopened.waitFor();
  expect(await reopened.getAttribute('aria-selected')).toBe('true');
  expect(await claude2.getByRole('tab', { name: new RegExp(`^Session ${tag(old.key)},`) }).count(), 'the old session did not come back as a tab').toBe(0);
  await claude2.getByRole('status').filter({ hasText: 'This session ended' }).getByRole('button', { name: 'Resume session' }).waitFor();
  const afterRestart = await h2.api.call('sessions.list', { query: { includeEnded: true } });
  expect(afterRestart.find((s) => s.key === old.key)?.replacedBy).toBe(fresh.key); // the history still names its successor
  evidence('X06', `in a managed session ${tag(old.key)} the person typed /clear: the fake CLI ended it and started ${tag(fresh.key)} in the same process (pid ${oldView.pid}); the core kept the terminal managed (old session replacedBy ${tag(fresh.key)}, new one live and managed), the Claude pane showed exactly one tab, the new session's, selected and not ended, with no "session ended" notice; the screen kept the earlier output and showed the new conversation; typing "${after}" reached the new session (the old one received nothing more); the Sessions menu listed "${tag(old.key)}, managed, Session ended, went on as ${tag(fresh.key)}"; the core's settings remembered ${tag(fresh.key)} as the project's tab; after quitting and starting again on the same data directory the pane reopened on ${tag(fresh.key)} (ended, with Resume) and not on ${tag(old.key)}`);
}, { timeout: 150_000 });
