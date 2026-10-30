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

export async function openEditProject(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: `Edit ${name}` }).click();
  const dialog = projectDialog(page, `Edit ${name}`);
  await dialog.waitFor();
  return dialog;
}

export async function addConversationInDialog(dialog: Locator, url: string): Promise<void> {
  await dialog.getByLabel('Add a conversation').fill(url);
  await dialog.getByRole('button', { name: 'Add conversation' }).click();
}

/** Types the address of a folder and adds it (the path is typed, not picked). */
export async function addFolderByTyping(dialog: Locator, folder: string): Promise<void> {
  await dialog.getByLabel('Add a folder').fill(folder);
  await dialog.getByRole('button', { name: 'Add folder' }).click();
}

/** Presses Browse (the native picker is answered by the test) and adds the folder it returned. */
export async function addFolderWithPicker(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Browse' }).click();
  await dialog.getByRole('button', { name: 'Add folder' }).click();
}

export interface UiProject {
  name: string;
  folder: string;
  conversations?: string[];
  /** 0-based index of the conversation to prefer, when not the first. */
  preferred?: number;
  github?: string;
}

/** Creates a project through the dialog, the way a person would, and waits until the dialog has closed and the project is selected. */
export async function createProjectInUi(page: Page, project: UiProject): Promise<void> {
  const dialog = await openNewProject(page);
  await dialog.getByLabel('Name', { exact: true }).fill(project.name);
  if (project.github) await dialog.getByLabel('GitHub repository').fill(project.github);
  await addFolderByTyping(dialog, project.folder);
  for (const url of project.conversations ?? []) await addConversationInDialog(dialog, url);
  if (project.preferred !== undefined && project.preferred > 0) {
    await dialog.getByRole('radio').nth(project.preferred).check();
  }
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('heading', { level: 1, name: project.name }).waitFor();
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions and tabs

export const claudeTabs = (page: Page): Locator => page.getByRole('region', { name: 'Claude', exact: true }).getByRole('tablist', { name: 'Claude sessions' }).getByRole('tab');

/** Starts a session with the empty-state button, or with the "+" menu when the project already has one. */
export async function startSessionInUi(page: Page): Promise<void> {
  const claude = page.getByRole('region', { name: 'Claude', exact: true });
  const start = claude.getByRole('button', { name: 'Start a session' });
  if (await start.isVisible()) { await start.click(); return; }
  await claude.getByRole('button', { name: 'New or resumed session' }).click();
  await page.getByRole('menuitem', { name: 'New session' }).click();
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
