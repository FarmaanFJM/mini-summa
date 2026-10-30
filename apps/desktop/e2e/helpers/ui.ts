// Driving the real window the way a person does: by what controls are called and what role they have (getByRole / getByLabel).
// No test ids and no CSS selectors for controls. The two CSS selectors that remain read OUTPUT (terminal rows) in terminal.ts.
import type { Locator, Page } from 'playwright';
import { until } from './wait.ts';

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------------------------------------------
// Navigation

export const projectsNav = (page: Page): Locator => page.getByRole('navigation', { name: 'Projects' });
export const sectionsNav = (page: Page): Locator => page.getByRole('navigation', { name: 'Sections' });

/** The sidebar row of a project. Its accessible name is the project's name followed by its facts ("Alpha, 1 live session"). */
export const projectRow = (page: Page, name: string): Locator => projectsNav(page).getByRole('button', { name: new RegExp(`^${escapeRe(name)}(,|$)`) });

/** The row of a project whose spoken facts include `fact`, for example "1 live session" or "2 reports waiting for handoff". */
export const projectRowWith = (page: Page, name: string, fact: string): Locator =>
  projectsNav(page).getByRole('button', { name: new RegExp(`^${escapeRe(name)}, (.*, )?${escapeRe(fact)}`) });

export async function selectProject(page: Page, name: string): Promise<void> {
  await showWorkspace(page);
  const row = projectRow(page, name);
  await row.click();
  await until(`${name} to be the selected project`, async () => (await row.getAttribute('aria-current')) === 'true');
  await page.getByRole('heading', { level: 1, name }).waitFor();
}

/** Leave Reports / Settings / Activity (which replace the sidebar or the workspace) and come back to the project list. */
export async function showWorkspace(page: Page): Promise<void> {
  // "Back" returns to the view before this one, which may itself be Reports or Settings: press it until the project list is back.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await projectsNav(page).isVisible()) return;
    await page.getByRole('button', { name: 'Back', exact: true }).first().click();
    await projectsNav(page).waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  }
  await projectsNav(page).waitFor({ state: 'visible' });
}

export async function openActivity(page: Page): Promise<void> {
  await showWorkspace(page);
  await sectionsNav(page).getByRole('button', { name: /^Activity/ }).click();
  await page.getByRole('region', { name: 'Activity', exact: true }).waitFor();
}

export async function openReports(page: Page): Promise<void> {
  await showWorkspace(page);
  await sectionsNav(page).getByRole('button', { name: /^Reports/ }).click();
  await page.getByRole('region', { name: 'Reports', exact: true }).waitFor();
}

export async function openSettings(page: Page): Promise<void> {
  await showWorkspace(page);
  await sectionsNav(page).getByRole('button', { name: /^Settings/ }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).waitFor();
}

// ---------------------------------------------------------------------------------------------------------------
// Projects

export const projectDialog = (page: Page, title: string): Locator => page.getByRole('dialog', { name: title });

/** "New project" in the sidebar (or "Create project" when there is none yet). */
export async function openNewProject(page: Page): Promise<Locator> {
  await showWorkspace(page);
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = projectDialog(page, 'New project');
  await dialog.waitFor();
  return dialog;
}

/**
 * The settings of a project ("<name> settings"). From the pencil in the workspace header when it is there, else from the project's
 * menu in the sidebar, which works for any project in the list.
 */
export async function openEditProject(page: Page, name: string): Promise<Locator> {
  const pencil = page.getByRole('button', { name: new RegExp(`^(Edit ${escapeRe(name)}|(Project )?settings( for| of)? ${escapeRe(name)}|${escapeRe(name)} settings)$`, 'i') });
  if (await pencil.count() > 0) await pencil.first().click();
  else {
    await showWorkspace(page);
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    await page.getByRole('menuitem', { name: /^(Edit project|Project settings|Settings)$/ }).click();
  }
  const dialog = projectDialog(page, `${name} settings`);
  await dialog.waitFor();
  return dialog;
}

/** The dialog that creates a project has the "Start from" choice; the settings of a project do not. */
const isNewProject = async (dialog: Locator): Promise<boolean> => (await dialog.getByRole('tablist', { name: 'Start from' }).count()) > 0;

/** Chooses how the new project starts: "ChatGPT Project", "GitHub repository", "Local folder" or "Empty project". */
export async function chooseSource(dialog: Locator, source: 'ChatGPT Project' | 'GitHub repository' | 'Local folder' | 'Empty project'): Promise<void> {
  const tab = dialog.getByRole('tab', { name: source, exact: true });
  await tab.click();
  await until(`"${source}" to be chosen`, async () => (await tab.getAttribute('aria-selected')) === 'true');
}

/** The folders the settings of a project list, as text. */
export const listedFolders = (dialog: Locator): Locator => dialog.getByRole('list', { name: 'Local folders' });

/**
 * Gives the project a folder by typing its path. In the New project dialog that is the "Local folder" way to start (the path is
 * the project's folder, there is nothing to add); in a project's settings it is "Add folder", and the folder is listed when this returns.
 */
export async function addFolderByTyping(dialog: Locator, folder: string): Promise<void> {
  if (await isNewProject(dialog)) {
    await chooseSource(dialog, 'Local folder');
    await dialog.getByLabel('Folder', { exact: true }).fill(folder);
    return;
  }
  await dialog.getByLabel('Folder path').fill(folder);
  await dialog.getByRole('button', { name: 'Add folder', exact: true }).click();
  await listedFolders(dialog).getByText(folder, { exact: true }).waitFor();
}

/**
 * Presses Browse (the native picker is answered by the test). In the New project dialog the folder it returns is the project's folder;
 * in a project's settings it is added to the project at once. Either way there is no second button to press.
 */
export async function addFolderWithPicker(dialog: Locator): Promise<void> {
  if (await isNewProject(dialog)) await chooseSource(dialog, 'Local folder');
  await dialog.getByRole('button', { name: 'Browse', exact: true }).click();
}

/** The conversations a project's settings list, one row each. */
export const listedConversations = (dialog: Locator): Locator => dialog.getByRole('radiogroup', { name: 'Preferred conversation' });

/**
 * Adds a ChatGPT conversation in a project's settings and waits until the core has it: its address is then listed in its row.
 * `url` is the address as the core keeps it (no query, no fragment).
 */
export async function addConversationInDialog(dialog: Locator, url: string): Promise<void> {
  await dialog.getByLabel('Conversation address').fill(url);
  await dialog.getByRole('button', { name: 'Add conversation' }).click();
  await listedConversations(dialog).getByText(url, { exact: true }).waitFor();
}

/** Presses Done in a project's settings and waits until it has closed. Everything was applied as it was done, so nothing is saved here. */
export async function closeSettings(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}

/** The words next to a project's name in the workspace header: its repository and folders. */
export async function projectHeaderText(page: Page, name: string): Promise<string> {
  return (await page.getByRole('heading', { level: 1, name, exact: true }).locator('..').textContent()) ?? '';
}

export interface UiProject {
  name: string;
  folder: string;
  conversations?: string[];
  /** 0-based index of the conversation to prefer, when not the first. */
  preferred?: number;
  github?: string;
}

/**
 * Creates a project the way a person would and waits until the dialog has closed and the project is selected: it starts from its
 * folder. What a project has besides (a GitHub repository, ChatGPT conversations and which one is preferred) is then set in its settings.
 */
export async function createProjectInUi(page: Page, project: UiProject): Promise<void> {
  const dialog = await openNewProject(page);
  await dialog.getByLabel('Name', { exact: true }).fill(project.name);
  await addFolderByTyping(dialog, project.folder);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('heading', { level: 1, name: project.name }).waitFor();
  if (!project.github && !(project.conversations ?? []).length) return;

  const settings = await openEditProject(page, project.name);
  if (project.github) {
    await settings.getByLabel('GitHub repository').fill(project.github);
    await settings.getByLabel('GitHub repository').press('Enter');
    await settings.getByText('Saved').first().waitFor();
  }
  for (const url of project.conversations ?? []) await addConversationInDialog(settings, url);
  if (project.preferred !== undefined && project.preferred > 0) {
    await settings.getByRole('radio').nth(project.preferred).check();
  }
  await closeSettings(settings);
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions and tabs

/** The session tabs of the Claude pane ("Session a1b2c3d4, managed, ..."). The Cloud tab of a project with a GitHub repository is not one of them. */
export const claudeTabs = (page: Page): Locator => page.getByRole('region', { name: 'Claude', exact: true }).getByRole('tablist', { name: 'Claude sessions' }).getByRole('tab', { name: /^Session / });

/** The Cloud tab of the Claude pane (Claude Code on the web). It exists for a project with a GitHub repository. */
export const cloudTab = (page: Page): Locator => page.getByRole('region', { name: 'Claude', exact: true }).getByRole('tab', { name: /^Cloud/ });

/** Starts a LOCAL session with the empty-pane button, or with the "+" menu when the project already has a tab. */
export async function startSessionInUi(page: Page): Promise<void> {
  const claude = page.getByRole('region', { name: 'Claude', exact: true });
  const start = claude.getByRole('button', { name: 'New local session' });
  if (await start.isVisible()) { await start.click(); return; }
  await claude.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New local session' }).click();
}

// ---------------------------------------------------------------------------------------------------------------
// Reports and the handoff

export const reportList = (page: Page): Locator => page.getByRole('list', { name: 'Reports' });

/** The row of a report in the queue. Its accessible name starts with the task title. */
export const reportRow = (page: Page, task: string): Locator => reportList(page).getByRole('button', { name: new RegExp(`^${escapeRe(task)},`) });

export async function openReport(page: Page, task: string): Promise<Locator> {
  await openReports(page);
  await reportRow(page, task).click();
  const detail = reportDetail(page);
  await detail.getByRole('heading', { level: 1, name: task }).waitFor();
  return detail;
}

export const reportDetail = (page: Page): Locator => page.getByRole('region', { name: 'Report', exact: true });
export const handoffCard = (page: Page): Locator => page.getByRole('region', { name: 'Handoff to ChatGPT', exact: true });

/** The handoff strip above the two panes of the workspace (present only while a report of the selected project waits for the person). */
export const handoffStrip = (page: Page): Locator => page.getByRole('region', { name: /^Report handoff/ });
