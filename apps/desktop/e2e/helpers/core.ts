// Arrangement and independent verification through the core's own typed client (@minisumma/shared MiniSummaClient): the
// same API the renderer and the Android app use. The tests drive the UI for the behaviour under test and use this for set-up
// and for reading back what the UI claims.
import type { Conversation, Delivery, Project, Report, ReportSummary, SessionKey, SessionView } from '@minisumma/shared';
import type { AppHandle } from './app.ts';
import { makeRepo } from './sandbox.ts';
import { until } from './wait.ts';

export interface MadeProject { project: Project; dir: string; conversations: Conversation[] }

/** A project whose repository really exists, with conversations added in order; `preferred` picks which one is preferred. */
export async function createProject(h: AppHandle, name: string, options: { conversations?: string[]; preferred?: number; github?: string; git?: boolean } = {}): Promise<MadeProject> {
  const dir = makeRepo(h.sandbox, name, { git: options.git });
  const project = await h.api.call('projects.create', { body: { name, githubRepo: options.github, roots: [{ path: dir }] } });
  const conversations: Conversation[] = [];
  for (const url of options.conversations ?? []) conversations.push(await h.api.call('conversations.add', { params: { id: project.id }, body: { url } }));
  if (options.preferred !== undefined && conversations[options.preferred]) {
    await h.api.call('conversations.setPreferred', { params: { id: project.id }, body: { conversationId: conversations[options.preferred].id } });
  }
  return { project: await h.api.call('projects.get', { params: { id: project.id } }), dir, conversations };
}

/** Starts a managed session through the core and waits until Claude has shown its first hook (the state is no longer "Starting"). */
export async function startSession(h: AppHandle, projectId: string, options: { name?: string } = {}): Promise<SessionView> {
  const started = await h.api.call('sessions.start', { params: { id: projectId }, body: { mode: 'new', name: options.name } });
  return waitForSession(h, started.key, (s) => s.state !== 'unknown', `session ${started.key} to finish starting`);
}

export async function waitForSession(h: AppHandle, key: SessionKey, test: (s: SessionView) => boolean, what: string, timeout = 20_000): Promise<SessionView> {
  return until(what, async () => {
    const view = await h.api.call('sessions.get', { params: { key } });
    return test(view) ? view : null;
  }, { timeout });
}

export async function reportsOf(h: AppHandle, projectId?: string): Promise<ReportSummary[]> {
  return (await h.api.call('reports.list', { query: projectId ? { projectId } : {} })).items;
}

/** Waits until a project has exactly `count` reports (or at least, with `atLeast`), then returns them newest first. */
export async function waitForReports(h: AppHandle, projectId: string, count: number, options: { timeout?: number } = {}): Promise<ReportSummary[]> {
  return until(`${count} report(s) for project ${projectId}`, async () => {
    const items = await reportsOf(h, projectId);
    return items.length >= count ? items : null;
  }, { timeout: options.timeout ?? 30_000 });
}

export async function fullReport(h: AppHandle, id: string): Promise<Report> {
  return h.api.call('reports.get', { params: { id } });
}

export async function latestDelivery(h: AppHandle, reportId: string): Promise<Delivery> {
  const list = await h.api.call('deliveries.list', { query: { reportId } });
  const last = list.at(-1);
  if (!last) throw new Error(`Report ${reportId} has no delivery.`);
  return last;
}
