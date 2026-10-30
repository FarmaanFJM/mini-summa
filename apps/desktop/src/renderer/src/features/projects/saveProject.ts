// Runs the plan from planSave against the core, one call at a time, and remembers what was created so that a failure in the
// middle can be retried without creating anything twice.
import type { Project } from '@minisumma/shared';
import type { ApiClient } from '../../app/api';
import type { SaveOp } from './projectDraft';

export interface SaveProgress {
  /** The project, once it exists (created now or edited). */
  projectId: string | null;
  /** Draft key to the id the core gave it. */
  rootIds: Record<string, string>;
  conversationIds: Record<string, string>;
}

export class SaveFailure extends Error {
  constructor(message: string, readonly progress: SaveProgress, readonly op: SaveOp) {
    super(message);
    this.name = 'SaveFailure';
  }
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const STEP_LABEL: Record<SaveOp['kind'], string> = {
  create: 'create the project',
  update: 'save the name and repository',
  removeRoot: 'remove a folder',
  addRoot: 'add a folder',
  removeConversation: 'remove a conversation',
  renameConversation: 'rename a conversation',
  addConversation: 'add a conversation',
  setPreferred: 'set the preferred conversation',
};

export async function runSave(api: ApiClient, ops: readonly SaveOp[], projectId: string | null): Promise<SaveProgress> {
  const progress: SaveProgress = { projectId, rootIds: {}, conversationIds: {} };
  for (const op of ops) {
    try {
      switch (op.kind) {
        case 'create': {
          const project: Project = await api.call('projects.create', {
            body: {
              name: op.name, githubRepo: op.githubRepo, ...(op.defaultEnv ? { defaultEnv: op.defaultEnv } : {}),
              roots: op.roots.map((r) => ({ path: r.path, env: r.env })),
            },
          });
          progress.projectId = project.id;
          // The core keeps roots in the order they were sent.
          op.roots.forEach((r, i) => { const created = project.roots[i]; if (created) progress.rootIds[r.key] = created.id; });
          break;
        }
        case 'update': await api.call('projects.update', { params: { id: need(progress) }, body: op.patch }); break;
        case 'removeRoot': await api.call('projects.removeRoot', { params: { id: need(progress), rootId: op.rootId } }); break;
        case 'addRoot': {
          const project = await api.call('projects.addRoot', { params: { id: need(progress) }, body: { path: op.path, env: op.env } });
          const created = project.roots.find((r) => r.path === op.path && r.env === op.env);
          if (created) progress.rootIds[op.key] = created.id;
          break;
        }
        case 'removeConversation': await api.call('conversations.remove', { params: { id: op.id } }); break;
        case 'renameConversation': await api.call('conversations.update', { params: { id: op.id }, body: { title: op.title } }); break;
        case 'addConversation': {
          const created = await api.call('conversations.add', { params: { id: need(progress) }, body: { url: op.url, title: op.title, makePreferred: op.makePreferred } });
          progress.conversationIds[op.key] = created.id;
          break;
        }
        case 'setPreferred': await api.call('conversations.setPreferred', { params: { id: need(progress) }, body: { conversationId: op.conversationId } }); break;
      }
    } catch (err) {
      throw new SaveFailure(`Could not ${STEP_LABEL[op.kind]}: ${reason(err)}`, progress, op);
    }
  }
  return progress;
}

function need(progress: SaveProgress): string {
  if (!progress.projectId) throw new Error('The project does not exist yet.');
  return progress.projectId;
}
