// Scenes the report tests start from: a project with a running Claude session, and "Claude finishes a task".
import type { Conversation, Project, ReportSummary, SessionView } from '@minisumma/shared';
import type { AppHandle } from './app.ts';
import { createProject, reportsOf, startSession } from './core.ts';
import { directive } from './fake-claude.ts';
import { observe } from './terminal.ts';
import { until } from './wait.ts';

export interface Scene { project: Project; dir: string; conversations: Conversation[]; session: SessionView }

/** A project (with these conversations, one preferred) and a running session in it. */
export async function sceneWithSession(h: AppHandle, name: string, options: { conversations?: string[]; preferred?: number } = {}): Promise<Scene> {
  const made = await createProject(h, name, options);
  const session = await startSession(h, made.project.id);
  return { project: made.project, dir: made.dir, conversations: made.conversations, session };
}

/**
 * Claude finishes a task: the prompt tells the fake model to end its turn with a report. The prompt reaches the PTY from the
 * core's terminal stream, a second keyboard, so the window's own selection and focus are not touched.
 */
export async function finishTask(h: AppHandle, scene: Pick<Scene, 'project' | 'session'>, task: string, status: 'complete' | 'partial' | 'blocked' = 'complete'): Promise<ReportSummary> {
  const before = (await reportsOf(h, scene.project.id)).length;
  const stream = await observe(h, scene.session.key);
  await stream.type(`Please finish: ${task} ${directive.report({ task, status })}`);
  const reports = await until(`the report "${task}" to be captured for ${scene.project.name}`, async () => {
    const list = await reportsOf(h, scene.project.id);
    return list.length > before && list.some((r) => r.taskTitle === task) ? list : null;
  }, { timeout: 30_000 });
  return reports.find((r) => r.taskTitle === task)!;
}
