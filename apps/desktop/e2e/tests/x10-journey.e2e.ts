// X10: the whole journey of the round-3 request, in the real window, from nothing to a restart.
//
//   a workspace is made from an EXISTING ChatGPT Project (its address pasted), a GitHub repository is associated, the local folder is
//   left empty; the linked project opens in the embedded ChatGPT; the page is given room by the page size setting; Claude's cloud entry
//   point opens Claude Code on the web with the repository preselected (and nothing started, typed or submitted); Split, ChatGPT and
//   Claude views are switched without anything being reloaded or lost; and after a restart every association is still there.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. Every page here comes from a local stand-in for chatgpt.com and claude.ai (an HTTPS server on
// loopback with a throw-away certificate, reached through the host-resolver seam). It proves what Mini-Summa does with addresses and
// views in the real Electron window. It proves nothing about the real sites: not their markup, not their sign-in, not whether a
// ChatGPT Project address of today still has this shape, not whether claude.ai accepts an embedded view, not whether the overlap of
// ChatGPT's floating controls is gone (it was never reproduced), and nothing about Windows. See docs/CLOUD_SESSIONS.md,
// docs/CHATGPT_PROJECTS.md and docs/CHATGPT_PANE.md.
import { expect } from 'vitest';
import { launchApp } from '../helpers/app.ts';
import { evidence } from '../helpers/evidence.ts';
import { chatgptView, claudeWebView, inEmbeddedPage, standInPageState, typeIntoComposer } from '../helpers/main-process.ts';
import { scenario } from '../helpers/scenario.ts';
import { projectScope, projectUrl } from '../helpers/standin.ts';
import { chooseSource, closeSettings, cloudTab, openEditProject, openNewProject, projectHeaderText, projectRow } from '../helpers/ui.ts';
import { until } from '../helpers/wait.ts';

const NAME = 'Caissa trainer'; // what the words in the pasted address turn into
const REPO = 'acme/caissa-trainer';
const DRAFT = 'a half-written thought that must survive';

scenario('[X10] A workspace from an existing ChatGPT Project and a GitHub repository, with no folder, works end to end and survives a restart', async () => {
  const h = await launchApp();
  const scope = projectScope('ca55a1', 'caissa-trainer');
  const project = projectUrl(scope);
  const title = 'Stand-in: Caissa Trainer (ChatGPT Project)';
  h.standIn.nameProject(scope, title);

  // 1. Create the workspace from the existing ChatGPT Project. The pasted address carries an invitation-shaped query and a fragment:
  //    neither may be kept, and the dialog says that only the address is saved.
  const create = await openNewProject(h.page);
  await chooseSource(create, 'ChatGPT Project');
  await create.getByLabel('Address of an existing ChatGPT Project').fill(`${project}?invite=SECRET-TOKEN#top`);
  await create.getByText(/Nothing in the project is imported or synced/).waitFor();
  await create.getByRole('button', { name: 'Create project' }).click();
  await create.waitFor({ state: 'detached' });
  await h.page.getByRole('heading', { level: 1, name: NAME }).waitFor();

  const [made] = await h.api.call('projects.list');
  expect(made).toMatchObject({ name: NAME, githubRepo: null, roots: [] });
  expect(made.chatgptProject).toMatchObject({ url: project, scopeId: scope });
  expect(JSON.stringify(made)).not.toContain('SECRET');

  // 2. The linked project is what the embedded ChatGPT shows: the project page, not a conversation (none is mapped).
  const front = await until('the linked ChatGPT Project to be the page in front', async () => {
    const view = await chatgptView(h.app);
    return view && view.url === project && !view.loading ? view : null;
  });
  expect(front.title).toBe(title);
  expect(front.visible).toBe(true);
  expect(h.standIn.requests.some((r) => r.search.includes('SECRET'))).toBe(false); // the invitation never left the app
  expect(await h.api.call('conversations.list', { params: { id: made.id } })).toEqual([]);

  // 3. The page was given room: Automatic zooms the view out when its pane is narrower than 900 DIP. This is the mechanism the
  //    overlap mitigation relies on, read from the page itself. (Whether it removes the overlap on the real site is NOT shown.)
  const paneWidth = front.bounds!.width;
  const cssWidth = (await inEmbeddedPage<number>(h.app, 'persist:chatgpt', 'window.innerWidth'))!;
  if (paneWidth < 900) expect(cssWidth).toBeGreaterThan(paneWidth + 50);
  else expect(cssWidth).toBe(Math.round(paneWidth));

  // 4. Associate the GitHub repository, in the project's settings; the local folder stays empty.
  const settings = await openEditProject(h.page, NAME);
  await settings.getByLabel('GitHub repository').fill(REPO);
  await settings.getByLabel('GitHub repository').press('Enter');
  await settings.getByText('Saved').first().waitFor();
  await closeSettings(settings);
  expect((await h.api.call('projects.list'))[0]).toMatchObject({ githubRepo: REPO, roots: [] });
  const header = await projectHeaderText(h.page, NAME);
  expect(header).toContain(REPO);
  expect(header).not.toMatch(/no folder/i); // a project without a folder is not an incomplete one

  // 5. Claude's cloud entry point. Local is impossible without a folder and says so; cloud is possible. Choosing cloud opens Claude Code
  //    on the web with the repository preselected, and starts nothing.
  const claude = h.page.getByRole('region', { name: 'Claude', exact: true });
  await claude.getByText('Local sessions need a folder on this computer.').waitFor();
  expect(await claude.getByRole('button', { name: 'New local session' }).isDisabled()).toBe(true);
  const mark = h.standIn.mark();
  await claude.getByRole('button', { name: 'New cloud session' }).click();
  const cloud = await until('Claude Code on the web to be in front', async () => {
    const view = await claudeWebView(h.app);
    return view && view.url.startsWith('https://claude.ai/code') && !view.loading ? view : null;
  });
  expect(cloud.url).toBe(`https://claude.ai/code?repositories=${REPO}`);
  expect(await inEmbeddedPage<string>(h.app, 'persist:claude', 'document.getElementById("repositories").textContent')).toBe(REPO);
  expect(await cloudTab(h.page).count()).toBe(1);
  expect(await h.api.call('sessions.list')).toEqual([]); // cloud was asked for, so no local session was started in its place
  expect(h.standIn.claudeSince(mark).filter((r) => r.path.startsWith('/code')).map((r) => `${r.method} ${r.path}${r.search}`)).toEqual([`GET /code?repositories=${REPO}`]);
  expect(await inEmbeddedPage<string[]>(h.app, 'persist:claude', 'window.__standin.events')).toEqual([]); // nothing typed, pasted, clicked or submitted
  expect(h.standIn.submissions()).toEqual([]);

  // 6. Views. The person has a half-written message in ChatGPT; Split, Claude only, ChatGPT only, Split again. The same page, the same
  //    draft, nothing requested again, and a hidden view really is hidden.
  await typeIntoComposer(h.app, 'persist:chatgpt', DRAFT);
  const idBefore = (await chatgptView(h.app))!.id;
  const claudeIdBefore = (await claudeWebView(h.app))!.id;
  const requests = h.standIn.mark();
  const views = h.page.getByRole('radiogroup', { name: 'Workspace view' });

  await views.getByRole('radio', { name: 'Claude' }).click();
  await until('ChatGPT to be hidden and Claude shown', async () => (await chatgptView(h.app))?.visible === false && (await claudeWebView(h.app))?.visible === true);
  await views.getByRole('radio', { name: 'ChatGPT' }).click();
  await until('Claude to be hidden and ChatGPT shown', async () => (await chatgptView(h.app))?.visible === true && (await claudeWebView(h.app))?.visible === false);
  await views.getByRole('radio', { name: 'Split' }).click();
  await until('both to be shown', async () => (await chatgptView(h.app))?.visible === true && (await claudeWebView(h.app))?.visible === true);

  expect((await chatgptView(h.app))!.id).toBe(idBefore);
  expect((await claudeWebView(h.app))!.id).toBe(claudeIdBefore);
  expect((await standInPageState(h.app))?.composer).toBe(DRAFT);
  expect(h.standIn.since(requests)).toEqual([]);

  // 7. Restart on the same data directory and profile: every association is intact, ChatGPT shows the linked project again, and the Cloud
  //    tab remembers its page.
  expect((await h.quit()).code).toBe(0);
  const h2 = await launchApp({ sandbox: h.sandbox, standIn: h.standIn });
  await projectRow(h2.page, NAME).waitFor();
  const [again] = await h2.api.call('projects.list');
  expect(again).toMatchObject({ id: made.id, name: NAME, githubRepo: REPO, roots: [] });
  expect(again.chatgptProject).toMatchObject({ url: project, scopeId: scope });
  await until('the linked project to be in front again', async () => {
    const view = await chatgptView(h2.app);
    return view && view.url === project && !view.loading ? view : null;
  });
  await cloudTab(h2.page).click();
  await until('the Cloud tab to open its remembered page', async () => {
    const view = await claudeWebView(h2.app);
    return view && view.url === `https://claude.ai/code?repositories=${REPO}` && !view.loading ? view : null;
  });
  expect(await h2.api.call('sessions.list')).toEqual([]);

  evidence('X10', `against local stand-ins for chatgpt.com and claude.ai only (NOT the real sites, NOT Windows): a workspace made from an existing ChatGPT Project address (query and fragment dropped, nothing imported) with a GitHub repository and no folder showed the project page in the embedded ChatGPT (page ${cssWidth} CSS px wide in a ${paneWidth} DIP pane), offered cloud but not local, opened Claude Code on the web at ?repositories=${REPO} with nothing typed, clicked or submitted and no local session started in its place, switched Split, Claude only, ChatGPT only and Split with the same two views, the same draft and no new request, and after a quit and a start kept every association and reopened the Cloud tab on its page`);
});
