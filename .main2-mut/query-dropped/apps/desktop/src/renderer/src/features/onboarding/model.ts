// What setup looks like from the state Mini-Summa already has. Nothing here is remembered as "done": every tick is a
// fact read from the core or the host, so it is right even if the person did the step in another way or another window.
import type { ChatGptViewState, Conversation, EnvironmentInfo, HookStatus, Project, SessionView, Settings } from '@minisumma/shared';

export type StepId = 'claude' | 'project' | 'conversation' | 'chatgpt' | 'hooks' | 'session';

export interface StepFacts {
  /** null while Mini-Summa is still looking. */
  envs: EnvironmentInfo[] | null;
  envError: string | null;
  /** Projects that are not archived. */
  projects: readonly Project[];
  conversations: readonly Conversation[];
  sessions: readonly SessionView[];
  hooks: readonly HookStatus[];
  settings: Settings | null;
  /** True inside the desktop app, which can show ChatGPT in a view of its own. */
  hasEmbeddedView: boolean;
  /** The embedded view's state; null before the host has answered or when there is no view. */
  view: ChatGptViewState | null;
}

export interface Step {
  id: StepId;
  title: string;
  done: boolean;
  /** An optional step never keeps the checklist open. */
  optional: boolean;
  /** One or two plain sentences: what was found, or what to do. */
  detail: string;
}

const claudeFoundIn = (e: EnvironmentInfo): boolean => e.available && e.claude.path !== null;

/**
 * Nothing about a project is required of it: a ChatGPT Project, a GitHub repository and local folders are each optional, so a project
 * that has only a repository is complete. What only a folder makes possible (a local Claude session, the reports it captures and so a
 * conversation to hand them to) is asked for while some project has a folder or none exists yet, and not once every project is
 * folderless.
 */
export const isFolderless = (projects: readonly Pick<Project, 'roots'>[]): boolean => projects.length > 0 && projects.every((p) => p.roots.length === 0);

const list = (names: readonly string[]): string => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

function claudeStep(f: StepFacts): Step {
  const found = (f.envs ?? []).filter(claudeFoundIn);
  const folderless = isFolderless(f.projects);
  const base = { id: 'claude' as const, title: 'Claude Code is installed', optional: folderless };
  if (f.envs === null) return { ...base, done: false, detail: f.envError ? `Mini-Summa could not look for Claude Code. ${f.envError}` : 'Looking for Claude Code.' };
  if (found.length > 0) {
    const withVersion = found.map((e) => (e.claude.version ? `${e.label} (version ${e.claude.version})` : e.label));
    return { ...base, done: true, detail: `Found in ${list(withVersion)}.` };
  }
  return {
    ...base, done: false,
    detail: `Mini-Summa did not find Claude Code in any environment. ${folderless ? 'Only local sessions need it. ' : ''}Install it, then press Refresh.`,
  };
}

function chatgptStep(f: StepFacts): Step {
  const base = { id: 'chatgpt' as const, title: 'Choose how ChatGPT opens', optional: false };
  const mode = f.settings?.chatgpt.mode ?? 'embedded';
  if (mode === 'external') {
    return { ...base, done: true, detail: f.settings?.chatgpt.externalBrowser === 'extension' ? 'ChatGPT opens in your browser, using the Mini-Summa extension to find the tab.' : 'ChatGPT opens in your browser.' };
  }
  if (!f.hasEmbeddedView) {
    return { ...base, done: false, detail: 'This window cannot show ChatGPT inside Mini-Summa. Choose your browser to have it open there.' };
  }
  const status = f.view?.status ?? 'idle';
  if (status === 'ready') return { ...base, done: true, detail: 'ChatGPT is loaded inside Mini-Summa.' };
  if (status === 'login_required') return { ...base, done: false, detail: 'ChatGPT asks you to sign in. Google sign-in is often refused inside embedded browsers. If it will not let you in, use your browser instead.' };
  if (status === 'challenge') return { ...base, done: false, detail: 'ChatGPT is showing a security check. Complete it in the view, or use your browser instead.' };
  if (status === 'blocked' || status === 'error') return { ...base, done: false, detail: f.view?.note ?? 'ChatGPT could not load inside Mini-Summa. Use your browser instead.' };
  return { ...base, done: false, detail: 'ChatGPT loads inside Mini-Summa when a project shows a ChatGPT page. If sign-in with Google is refused, use your browser instead.' };
}

/** The setup steps, in the order a person does them, each with whether it is done and what to do or what was found. */
export function deriveSteps(f: StepFacts): Step[] {
  const names = f.projects.map((p) => p.name);
  const activeIds = new Set(f.projects.map((p) => p.id));
  const withConversation = new Set(f.conversations.filter((c) => activeIds.has(c.projectId)).map((c) => c.projectId));
  const hooksOn = f.hooks.filter((h) => h.installed && h.missingEvents.length === 0 && !h.duplicateRegistrations);
  const managed = f.sessions.filter((s) => s.origin === 'managed');
  const noProject = f.projects.length === 0;
  const folderless = isFolderless(f.projects);

  return [
    claudeStep(f),
    {
      id: 'project', title: 'Create your first project', optional: false, done: !noProject,
      detail: noProject
        ? 'A project can have a ChatGPT Project, a GitHub repository and local folders. Each one is optional.'
        : `${list(names.slice(0, 3))}${names.length > 3 ? ` and ${names.length - 3} more` : ''}.`,
    },
    {
      id: 'conversation', title: 'Add its ChatGPT conversation', optional: folderless, done: withConversation.size > 0,
      detail: withConversation.size > 0
        ? `${withConversation.size === 1 ? 'One project has' : `${withConversation.size} projects have`} a conversation.`
        : noProject ? 'Create a project first.'
          : folderless ? 'Reports come from local sessions, which need a folder. Add a conversation when you want reports handed to ChatGPT.'
            : 'Paste the address of the ChatGPT conversation you use for this project, so reports can be handed to the right one.',
    },
    chatgptStep(f),
    {
      id: 'hooks', title: 'Install Claude hooks', optional: true, done: hooksOn.length > 0,
      detail: hooksOn.length > 0
        ? `Installed for ${list(hooksOn.map((h) => (f.envs?.find((e) => e.id === h.env)?.label ?? h.env)))}.`
        : 'Optional. Sessions that Mini-Summa starts work without it. Hooks add capture for Claude sessions you start yourself in other terminals.',
    },
    {
      id: 'session', title: 'Start a Claude session', optional: folderless, done: managed.length > 0,
      detail: managed.length > 0 ? 'A session has been started from Mini-Summa.'
        : noProject ? 'Create a project first.'
          : folderless ? 'A local session needs a folder. Add one in the project\'s settings.'
            : 'Open the project and start a Claude session in its terminal.',
    },
  ];
}

/** Every step that is not optional is done. */
export const isComplete = (steps: readonly Step[]): boolean => steps.every((s) => s.done || s.optional);

/** The step to do next: the first one that is not done and not optional. */
export const nextStep = (steps: readonly Step[]): Step | null => steps.find((s) => !s.done && !s.optional) ?? null;

export const doneCount = (steps: readonly Step[]): { done: number; total: number } => ({ done: steps.filter((s) => s.done).length, total: steps.length });
