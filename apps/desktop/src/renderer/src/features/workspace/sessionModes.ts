// The three ways to run Claude for a project, and which of them a project can use. Pure, so the rules are tested without React.
//
//   cloud      the official `claude --cloud`, on Anthropic's servers, from the project's GitHub repository
//   temporary  a checkout Mini-Summa downloads and owns, with Claude Code running locally in it
//   existing   one of the project's own folders
//
// One is never substituted for another: a mode that cannot start says what is missing, and nothing starts in its place.
import type { Project } from '@minisumma/shared';

export type SessionMode = 'cloud' | 'temporary' | 'existing';

export interface ModeChoice { available: boolean; reason: string | null }

export const MODE_LABEL: Record<SessionMode, string> = {
  cloud: 'Cloud session',
  temporary: 'Temporary local session',
  existing: 'Existing local session',
};

export const MODE_HELP: Record<SessionMode, string> = {
  cloud: 'Runs Claude on remote infrastructure using the official CLI.',
  temporary: 'Creates a temporary checkout of the GitHub repository and runs Claude locally.',
  existing: 'Uses one of the project\'s configured local folders.',
};

export const NEEDS_REPOSITORY = 'Needs a GitHub repository.';
export const NEEDS_FOLDER = 'Needs a folder on this computer.';

export function sessionModes(project: Pick<Project, 'roots' | 'githubRepo'>): Record<SessionMode, ModeChoice> {
  const repo = Boolean(project.githubRepo);
  const folder = project.roots.length > 0;
  return {
    cloud: { available: repo, reason: repo ? null : NEEDS_REPOSITORY },
    temporary: { available: repo, reason: repo ? null : NEEDS_REPOSITORY },
    existing: { available: folder, reason: folder ? null : NEEDS_FOLDER },
  };
}

/** The mode an empty pane puts first: the folder the person already has, else the cloud. */
export function primaryMode(project: Pick<Project, 'roots' | 'githubRepo'>): SessionMode | null {
  const modes = sessionModes(project);
  if (modes.existing.available) return 'existing';
  if (modes.cloud.available) return 'cloud';
  return null;
}

/** What to add to the project to make the missing modes possible, as the label of the way into its settings; null when nothing is missing. */
export function modesFix(project: Pick<Project, 'roots' | 'githubRepo'>): string | null {
  const m = sessionModes(project);
  if (m.existing.available && m.cloud.available) return null;
  if (m.existing.available) return 'Add a GitHub repository';
  if (m.cloud.available) return 'Add a folder';
  return 'Add a folder or a GitHub repository';
}

// ---------------------------------------------------------------------------------------------------------------
// Drafts

export interface Draft {
  mode: SessionMode;
  prompt: string;
  title: string;
  rootId: string | null;
  branch: string | null;
  featureBranch: string;
}

const drafts = new Map<string, Draft>();

/**
 * A half written prompt survives closing the dialog, switching tabs and switching projects, for as long as the app is open. It is kept
 * in memory only: never written to disk, to the database, to a log or to a URL, and gone when Mini-Summa quits. (A prompt can hold source
 * code and secrets; a file on disk would outlive the person's intention.)
 */
export const draftStore = {
  get(projectId: string): Draft | undefined { return drafts.get(projectId); },
  set(projectId: string, draft: Draft): void { drafts.set(projectId, draft); },
  clear(projectId: string): void { drafts.delete(projectId); },
  clearAll(): void { drafts.clear(); },
  size(): number { return drafts.size; },
};

export const emptyDraft = (mode: SessionMode): Draft => ({ mode, prompt: '', title: '', rootId: null, branch: null, featureBranch: '' });
