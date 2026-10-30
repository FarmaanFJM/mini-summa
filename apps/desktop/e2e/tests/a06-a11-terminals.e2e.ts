// A06-A11: real Claude-shaped terminals (the fake Claude CLI in a real PTY, started by the real core), shown in the real xterm.
// The person's keyboard goes in through Playwright key events; what happened is read back three ways: the fake's own files
// (what the process saw), the core's terminal stream and API (what the PTY and the core recorded), and the xterm on screen.
import fs from 'node:fs';
import { expect } from 'vitest';
import type { SessionKey } from '@minisumma/shared';
import { launchApp } from '../helpers/app.ts';
import { createProject, startSession, waitForSession } from '../helpers/core.ts';
import { evidence } from '../helpers/evidence.ts';
import { isRunning, liveSessionsOf, readReceived, readTerminalSize } from '../helpers/fake-claude.ts';
import { setWindowSize } from '../helpers/main-process.ts';
import { scenario } from '../helpers/scenario.ts';
import { observe, screenSize, screenText, terminalInput, typeLikeAPerson, waitForScreen } from '../helpers/terminal.ts';
import { claudeTabs, createProjectInUi, openEditProject, projectRowWith, selectProject, startSessionInUi } from '../helpers/ui.ts';
import { makeRepo } from '../helpers/sandbox.ts';
import { until } from '../helpers/wait.ts';

const received = (stateDir: string, key: SessionKey): string[] => readReceived(stateDir, key.split('|')[1]).map((r) => r.text);

scenario('[A06] Claude Code launches in the correct directory', async () => {
  const h = await launchApp();
  // A folder name with a space and brackets, because those are what break command lines.
  const folder = makeRepo(h.sandbox, 'My App (v2)', { verbatim: true });
  await createProjectInUi(h.page, { name: 'My App', folder });
  await openEditProject(h.page, 'My App').then((d) => d.getByRole('button', { name: 'Cancel' }).click());

  // Start it the way a person does: the button in the Claude pane.
  await startSessionInUi(h.page);
  await claudeTabs(h.page).first().waitFor();
  const [session] = await until('one managed session', async () => {
    const list = await h.api.call('sessions.list');
    return list.length === 1 ? list : null;
  });
  await waitForSession(h, session.key, (s) => s.state !== 'unknown', 'the session to leave Starting');

  // 1. The core: the session is a managed one of this project, started in the project's folder.
  const view = await h.api.call('sessions.get', { params: { key: session.key } });
  expect(view).toMatchObject({ origin: 'managed', availability: 'live', projectName: 'My App', cwd: folder });
  // 2. The operating system: the working directory of the process that is Claude.
  expect(fs.readlinkSync(`/proc/${view.pid}/cwd`)).toBe(folder);
  // 3. The process itself: the fake registers the directory it believes it runs in.
  const registered = liveSessionsOf(h.sandbox.fakeState);
  expect(registered).toHaveLength(1);
  expect(registered[0]).toMatchObject({ cwd: folder, pid: view.pid, sessionId: session.sessionId });
  // 4. The screen: Claude's own banner in the terminal shows the same directory.
  const screen = await waitForScreen(h.page, `cwd: ${folder}`);
  expect(screen).toContain(session.sessionId);
  evidence('A06', `project folder "${folder}" (space and brackets); core cwd, /proc/${view.pid}/cwd, the process's own registration and the banner on screen all name that folder; session ${session.sessionId.slice(0, 8)} is managed and bound to the project`);
});

scenario('[A07] Terminal input and output work', async () => {
  const h = await launchApp();
  const { project } = await createProject(h, 'Typing');
  const session = await startSession(h, project.id);
  await terminalInput(h.page).waitFor({ state: 'attached' });
  const stream = await observe(h, session.key);
  await waitForScreen(h.page, 'for shortcuts');

  // Keystrokes, including characters outside ASCII, go through xterm -> renderer -> core -> PTY -> Claude, and the answer comes back.
  const line = 'hello from the keyboard: café ✓ 42';
  await typeLikeAPerson(h.page, line);
  const screen = await waitForScreen(h.page, `fake-claude received ${line.length} characters`);
  expect(screen).toContain(`> ${line}`);
  expect(received(h.sandbox.fakeState, session.key)).toEqual([line]); // the process got exactly what was typed
  expect(stream.text()).toContain(`fake-claude received ${line.length} characters`); // and the core's stream saw the same output

  // Editing keys work: Backspace removes the last character before Enter.
  await terminalInput(h.page).focus();
  await h.page.keyboard.type('abcX');
  await h.page.keyboard.press('Backspace');
  await h.page.keyboard.type('d');
  await h.page.keyboard.press('Enter');
  await until('the second prompt to arrive', () => received(h.sandbox.fakeState, session.key).length === 2);
  expect(received(h.sandbox.fakeState, session.key)[1]).toBe('abcd');

  // Control keys reach the process too: Escape interrupts a turn that is still running.
  await waitForScreen(h.page, 'Echo: abcd');
  await typeLikeAPerson(h.page, 'a slow one [[fake:sleep=20000]]');
  await until('the slow prompt to arrive', () => received(h.sandbox.fakeState, session.key).length === 3);
  await waitForSession(h, session.key, (s) => s.state === 'working', 'Claude to be working on the slow prompt');
  await h.page.keyboard.press('Escape');
  await waitForScreen(h.page, 'Interrupted');

  // Output the person did not ask for arrives as well: the core types into the same PTY from the other keyboard.
  await stream.type('typed from the second keyboard');
  await waitForScreen(h.page, 'fake-claude received 30 characters');
  evidence('A07', `typed "${line}" with real key events: the fake received exactly that text, and its reply was shown on screen and in the core's stream; Backspace edited the line ("abcd" arrived); Escape interrupted a running turn ("Interrupted" shown); output from a second client appeared in the same terminal`);
});

scenario('[A08] Terminal resize works', async () => {
  const h = await launchApp();
  const { project } = await createProject(h, 'Resizing');
  const session = await startSession(h, project.id);
  await terminalInput(h.page).waitFor({ state: 'attached' });
  await waitForScreen(h.page, 'for shortcuts');
  const stateDir = h.sandbox.fakeState;
  const id = session.sessionId;

  const sizeNow = async () => {
    const view = await h.api.call('sessions.get', { params: { key: session.key } });
    return { core: view.terminal!, fake: readTerminalSize(stateDir, id) };
  };
  // The PTY, the process that runs in it and the xterm that draws it must agree on the size, at every size.
  const settle = async (what: string, previous: { cols: number; rows: number }) => {
    const now = await until(`${what}: the core, the fake and the screen to agree on a new size`, async () => {
      const s = await sizeNow();
      if (!s.fake || s.core.cols === previous.cols && s.core.rows === previous.rows) return null;
      if (s.fake.cols !== s.core.cols || s.fake.rows !== s.core.rows) return null;
      return s;
    });
    const screen = await screenSize(h.page);
    return { cols: now.core.cols, rows: now.core.rows, screen };
  };

  const initial = await sizeNow();
  expect(initial.fake).toMatchObject({ cols: initial.core.cols, rows: initial.core.rows });

  const tall = await setWindowSize(h.app, 1000, 1300); // stacked layout: a wide, shorter terminal
  const afterTall = await settle('after making the window tall', initial.core);
  const wide = await setWindowSize(h.app, 1500, 800);  // side by side: a narrower terminal
  const afterWide = await settle('after making the window wide', afterTall);
  expect([afterTall.cols, afterTall.rows]).not.toEqual([afterWide.cols, afterWide.rows]);
  expect([initial.core.cols, initial.core.rows]).not.toEqual([afterTall.cols, afterTall.rows]);

  // The process was told (SIGWINCH): its own words about it are in the terminal, and the xterm has that many rows.
  await waitForScreen(h.page, `[terminal resized to ${afterWide.cols}x${afterWide.rows}]`);
  if (afterWide.screen) {
    expect(afterWide.screen.rows).toBe(afterWide.rows);
    expect(Math.abs(afterWide.screen.cols - afterWide.cols)).toBeLessThanOrEqual(1);
  }
  evidence('A08', `window ${tall.contentSize.join('x')} -> terminal ${afterTall.cols}x${afterTall.rows}; window ${wide.contentSize.join('x')} -> ${afterWide.cols}x${afterWide.rows}; at each size the core's PTY record, the size the fake process reads from its terminal, and the xterm rows${afterWide.screen ? ` (${afterWide.screen.cols}x${afterWide.screen.rows} measured)` : ''} agree; the process printed "[terminal resized to ${afterWide.cols}x${afterWide.rows}]"`);
});

scenario('[A09] Switching projects does not terminate unrelated sessions', async () => {
  const h = await launchApp();
  const alpha = await createProject(h, 'Alpha');
  const beta = await createProject(h, 'Beta');
  const s1 = await startSession(h, alpha.project.id);
  const stateDir = h.sandbox.fakeState;
  await selectProject(h.page, 'Alpha');
  await terminalInput(h.page).waitFor({ state: 'attached' });
  await typeLikeAPerson(h.page, 'before the switch');
  await waitForScreen(h.page, 'fake-claude received 17 characters');
  const stream = await observe(h, s1.key);

  // Switch to Beta, start a session there, and use it.
  await selectProject(h.page, 'Beta');
  await startSessionInUi(h.page);
  await until('Beta to have a live session', async () => (await h.api.call('sessions.list', { query: { projectId: beta.project.id } })).some((s) => s.availability === 'live'));
  await typeLikeAPerson(h.page, 'in beta');
  await waitForScreen(h.page, 'fake-claude received 7 characters');
  expect(await screenText(h.page)).not.toContain('before the switch'); // Beta shows Beta's terminal, not Alpha's

  // Alpha's session was not touched: same process, same state, still registered, still receiving.
  const during = await h.api.call('sessions.get', { params: { key: s1.key } });
  expect(during).toMatchObject({ availability: 'live', pid: s1.pid, generation: s1.generation });
  expect(during.terminal?.exited).toBe(false);
  expect(isRunning(s1.pid!)).toBe(true);
  await stream.type('typed into alpha while beta is shown');
  await stream.waitFor('fake-claude received 36 characters');

  // Back to Alpha: the same terminal, with what happened before and while it was in the background.
  await selectProject(h.page, 'Alpha');
  const screen = await waitForScreen(h.page, 'fake-claude received 36 characters');
  expect(screen).toContain('before the switch');
  expect(received(stateDir, s1.key)).toEqual(['before the switch', 'typed into alpha while beta is shown']);
  const after = await h.api.call('sessions.get', { params: { key: s1.key } });
  expect(after).toMatchObject({ availability: 'live', pid: s1.pid, generation: s1.generation });
  expect(liveSessionsOf(stateDir).map((s) => s.pid)).toContain(s1.pid);
  evidence('A09', `Alpha's session (pid ${s1.pid}) stayed live, same pid and generation, while Beta was selected and used; output typed into Alpha during that time arrived; switching back showed one terminal with both the earlier and the background text; Beta's screen never showed Alpha's text`);
});

scenario('[A10] Multiple projects can be active', async () => {
  const h = await launchApp();
  const names = ['Alpha', 'Beta', 'Gamma'];
  const made = [] as Awaited<ReturnType<typeof createProject>>[];
  for (const name of names) made.push(await createProject(h, name));
  const sessions = [] as Awaited<ReturnType<typeof startSession>>[];
  for (const m of made) sessions.push(await startSession(h, m.project.id));

  // All three are live at once, each in its own folder, with its own process.
  expect(new Set(sessions.map((s) => s.key)).size).toBe(3);
  expect(new Set(sessions.map((s) => s.pid)).size).toBe(3);
  sessions.forEach((s, i) => expect(s).toMatchObject({ origin: 'managed', availability: 'live', projectId: made[i].project.id, cwd: made[i].dir }));
  for (const s of sessions) expect(isRunning(s.pid!)).toBe(true);
  expect(liveSessionsOf(h.sandbox.fakeState).map((r) => r.cwd).sort()).toEqual(made.map((m) => m.dir).sort());

  // The sidebar says so for every project, and each one shows its own terminal.
  for (const name of names) await projectRowWith(h.page, name, '1 live session').waitFor();
  for (const [i, name] of names.entries()) {
    await selectProject(h.page, name);
    await waitForScreen(h.page, `cwd: ${made[i].dir}`);
    await typeLikeAPerson(h.page, `message for ${name}`);
    await waitForScreen(h.page, `fake-claude received ${`message for ${name}`.length} characters`);
  }
  // Input went only where it was typed.
  sessions.forEach((s, i) => expect(received(h.sandbox.fakeState, s.key)).toEqual([`message for ${names[i]}`]));
  evidence('A10', `three projects, three live managed sessions (pids ${sessions.map((s) => s.pid).join(', ')}) in three folders at once; the sidebar showed "1 live session" on each; each project showed its own terminal and received only its own typed message`);
});

scenario('[A11] Multiple sessions can belong to one project', async () => {
  const h = await launchApp();
  const alpha = await createProject(h, 'Alpha');
  await selectProject(h.page, 'Alpha');

  // Two sessions, started the way a person starts them: the empty-state button, then the "+" menu.
  await startSessionInUi(h.page);
  await claudeTabs(h.page).first().waitFor();
  await startSessionInUi(h.page);
  await until('two tabs', async () => (await claudeTabs(h.page).count()) === 2);
  const sessions = await until('two live sessions of the project', async () => {
    const list = (await h.api.call('sessions.list', { query: { projectId: alpha.project.id } })).filter((s) => s.availability === 'live');
    return list.length === 2 ? list : null;
  });
  for (const s of sessions) await waitForSession(h, s.key, (v) => v.state !== 'unknown', `session ${s.key} to start`);
  expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(2);
  expect(sessions.every((s) => s.cwd === alpha.dir && s.projectId === alpha.project.id && s.origin === 'managed')).toBe(true);
  expect(sessions[0].pid).not.toBe(sessions[1].pid);

  // Each tab is its own terminal: it shows its own session id, and input goes to the selected one only.
  const [first, second] = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const tab = (key: SessionKey) => h.page.getByRole('tab', { name: new RegExp(`^Session ${key.split('|')[1].slice(0, 8)},`) });
  await tab(first.key).click();
  await waitForScreen(h.page, `session: ${first.sessionId}`);
  await typeLikeAPerson(h.page, 'for the first');
  await waitForScreen(h.page, 'fake-claude received 13 characters');
  await tab(second.key).click();
  await waitForScreen(h.page, `session: ${second.sessionId}`);
  expect(await screenText(h.page)).not.toContain('for the first');
  await typeLikeAPerson(h.page, 'for the second one');
  await waitForScreen(h.page, 'fake-claude received 18 characters');
  expect(received(h.sandbox.fakeState, first.key)).toEqual(['for the first']);
  expect(received(h.sandbox.fakeState, second.key)).toEqual(['for the second one']);

  // Closing a tab only hides the view: the session keeps running.
  await h.page.getByRole('button', { name: new RegExp(`^Close tab ${second.sessionId.slice(0, 8)}`) }).click();
  await until('one tab left', async () => (await claudeTabs(h.page).count()) === 1);
  const still = await h.api.call('sessions.get', { params: { key: second.key } });
  expect(still.availability).toBe('live');
  expect(isRunning(second.pid!)).toBe(true);
  evidence('A11', `two managed sessions of one project (pids ${first.pid} and ${second.pid}) in the same folder, two tabs; typed text reached only the selected tab's process; each tab showed its own session id; closing a tab left its process running`);
});
