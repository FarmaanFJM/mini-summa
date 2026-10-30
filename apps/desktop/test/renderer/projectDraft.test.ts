import { parseChatGptUrl } from '@minisumma/shared';
import type { Conversation, Project } from '@minisumma/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../src/renderer/src/app/api';
import { createSeed, IDS } from '../../src/renderer/src/dev/demo/seed';
import {
  addConversation, addRoot, draftFromProject, emptyDraft, normalizeGithubRepo, planSave, removeConversation, removeRoot, setPreferred,
  validateDraft, withPreferredRule,
} from '../../src/renderer/src/features/projects/projectDraft';
import type { ProjectDraft } from '../../src/renderer/src/features/projects/projectDraft';
import { runSave, SaveFailure } from '../../src/renderer/src/features/projects/saveProject';

const url = (id: string) => {
  const r = parseChatGptUrl(`https://chatgpt.com/c/${id}`);
  if (!r.ok) throw new Error(r.message);
  return r.info;
};
const U1 = url('11111111-1111-4111-8111-111111111111');
const U2 = url('22222222-2222-4222-8222-222222222222');
const U3 = url('33333333-3333-4333-8333-333333333333');

const withConversations = (...infos: typeof U1[]): ProjectDraft => {
  let draft = emptyDraft();
  for (const info of infos) {
    const added = addConversation(draft, info);
    if (!added.ok) throw new Error(added.message);
    draft = added.draft;
  }
  return draft;
};

describe('GitHub repository field', () => {
  it('accepts owner/repo and normalises the common ways of pasting one', () => {
    expect(normalizeGithubRepo('acme/git-manager')).toEqual({ ok: true, value: 'acme/git-manager', changed: false });
    expect(normalizeGithubRepo('https://github.com/acme/git-manager')).toEqual({ ok: true, value: 'acme/git-manager', changed: true });
    expect(normalizeGithubRepo('https://github.com/acme/git-manager.git')).toEqual({ ok: true, value: 'acme/git-manager', changed: true });
    expect(normalizeGithubRepo('git@github.com:acme/git-manager.git')).toEqual({ ok: true, value: 'acme/git-manager', changed: true });
    expect(normalizeGithubRepo('github.com/acme/git-manager/tree/main')).toEqual({ ok: true, value: 'acme/git-manager', changed: true });
  });

  it('treats an empty field as no repository', () => {
    expect(normalizeGithubRepo('   ')).toEqual({ ok: true, value: null, changed: false });
  });

  it('rejects anything else with a plain instruction', () => {
    const bad = normalizeGithubRepo('not a repo');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('owner/repo');
    expect(normalizeGithubRepo('one/two/three').ok).toBe(false);
  });

  it('validates the whole draft', () => {
    expect(validateDraft(emptyDraft()).name).toBe('Give the project a name.');
    expect(validateDraft({ ...emptyDraft(), name: 'x'.repeat(121) }).name).toContain('120');
    expect(validateDraft({ ...emptyDraft(), name: 'Ok', githubRepo: 'nope' }).githubRepo).toContain('owner/repo');
    expect(validateDraft({ ...emptyDraft(), name: 'Ok', githubRepo: 'a/b' })).toEqual({});
  });
});

describe('preferred conversation rules', () => {
  it('makes the first conversation preferred without being asked', () => {
    const draft = withConversations(U1);
    expect(draft.preferredKey).toBe(draft.conversations[0].key);
  });

  it('keeps the preference when more are added', () => {
    const draft = withConversations(U1, U2, U3);
    expect(draft.conversations).toHaveLength(3);
    expect(draft.preferredKey).toBe(draft.conversations[0].key);
  });

  it('refuses the same address twice', () => {
    const draft = withConversations(U1);
    const again = addConversation(draft, U1);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.message).toContain('already');
  });

  it('has exactly one preferred conversation at all times', () => {
    let draft = withConversations(U1, U2);
    draft = setPreferred(draft, draft.conversations[1].key);
    expect(draft.preferredKey).toBe(draft.conversations[1].key);
    // Setting an unknown key changes nothing.
    expect(setPreferred(draft, 'nope')).toBe(draft);
  });

  it('moves the preference to the next conversation when the preferred one is removed', () => {
    let draft = withConversations(U1, U2, U3);
    draft = removeConversation(draft, draft.conversations[0].key);
    expect(draft.conversations).toHaveLength(2);
    expect(draft.preferredKey).toBe(draft.conversations[0].key);
  });

  it('leaves no preference when the last conversation goes', () => {
    let draft = withConversations(U1);
    draft = removeConversation(draft, draft.conversations[0].key);
    expect(draft.preferredKey).toBeNull();
  });

  it('repairs a dangling preference', () => {
    const draft = withConversations(U1, U2);
    expect(withPreferredRule({ ...draft, preferredKey: 'gone' }).preferredKey).toBe(draft.conversations[0].key);
  });
});

describe('roots', () => {
  it('adds a folder once per environment and spelling', () => {
    let draft = emptyDraft();
    const first = addRoot(draft, 'win', 'C:\\Dev\\App');
    expect(first.ok).toBe(true);
    if (first.ok) draft = first.draft;
    const again = addRoot(draft, 'win', 'c:\\dev\\app');
    expect(again.ok).toBe(false);
    expect(addRoot(draft, 'wsl:Ubuntu', 'C:\\Dev\\App').ok).toBe(true);
    expect(removeRoot(draft, draft.roots[0].key).roots).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// What a save sends

const seed = createSeed(new Date('2026-10-30T10:00:00Z'));
const project = (id: string): Project => seed.projects.find((p) => p.id === id) as Project;
const conversationsOf = (id: string): Conversation[] => seed.conversations.filter((c) => c.projectId === id);

describe('planSave: creating', () => {
  it('creates the project with its roots, then adds conversations; the first one is preferred', () => {
    let draft = { ...emptyDraft(), name: '  Billing  ', githubRepo: 'https://github.com/acme/billing.git' };
    const root = addRoot(draft, 'win', 'C:\\Dev\\Billing');
    if (root.ok) draft = root.draft;
    draft = withConversations(U1, U2).conversations.length ? { ...draft, ...pick(withConversations(U1, U2)) } : draft;
    const ops = planSave(draft, null);
    expect(ops[0]).toMatchObject({ kind: 'create', name: 'Billing', githubRepo: 'acme/billing', roots: [{ path: 'C:\\Dev\\Billing', env: 'win' }] });
    expect(ops.slice(1).map((o) => o.kind)).toEqual(['addConversation', 'addConversation']);
    expect(ops.slice(1).map((o) => (o.kind === 'addConversation' ? o.makePreferred : null))).toEqual([true, false]);
  });

  it('asks the server for the chosen conversation when it is not the first', () => {
    let draft = { ...emptyDraft(), name: 'Billing', ...pick(withConversations(U1, U2)) };
    draft = setPreferred(draft, draft.conversations[1].key);
    const ops = planSave(draft, null);
    expect(ops.slice(1).map((o) => (o.kind === 'addConversation' ? o.makePreferred : null))).toEqual([false, true]);
  });
});

describe('planSave: editing', () => {
  const base = () => ({ project: project(IDS.gitManager), conversations: conversationsOf(IDS.gitManager) });

  it('sends nothing when nothing changed', () => {
    const draft = draftFromProject(project(IDS.gitManager), conversationsOf(IDS.gitManager));
    expect(planSave(draft, base())).toEqual([]);
  });

  it('sends only the fields that changed', () => {
    const draft = draftFromProject(project(IDS.gitManager), conversationsOf(IDS.gitManager));
    expect(planSave({ ...draft, name: 'GitManager 2' }, base())).toEqual([{ kind: 'update', patch: { name: 'GitManager 2' } }]);
    expect(planSave({ ...draft, githubRepo: '' }, base())).toEqual([{ kind: 'update', patch: { githubRepo: null } }]);
  });

  it('removes and adds roots', () => {
    let draft = draftFromProject(project(IDS.gitManager), conversationsOf(IDS.gitManager));
    draft = removeRoot(draft, draft.roots[0].key);
    const added = addRoot(draft, 'wsl:Ubuntu', '/home/dev/gm');
    if (added.ok) draft = added.draft;
    expect(planSave(draft, base()).map((o) => o.kind)).toEqual(['removeRoot', 'addRoot']);
  });

  it('renames a conversation by id', () => {
    let draft = draftFromProject(project(IDS.gitManager), conversationsOf(IDS.gitManager));
    draft = { ...draft, conversations: draft.conversations.map((c, i) => (i === 0 ? { ...c, title: ' Sprint planning ' } : c)) };
    expect(planSave(draft, base())).toEqual([{ kind: 'renameConversation', id: IDS.c.gmRelease, title: 'Sprint planning' }]);
  });

  it('sets a different existing conversation as preferred', () => {
    let draft = draftFromProject(project(IDS.gitManager), conversationsOf(IDS.gitManager));
    draft = setPreferred(draft, IDS.c.gmReview);
    expect(planSave(draft, base())).toEqual([{ kind: 'setPreferred', conversationId: IDS.c.gmReview }]);
  });

  it('restates the preference after removing the preferred conversation, because the core may have moved it', () => {
    let draft = draftFromProject(project(IDS.gitManager), conversationsOf(IDS.gitManager));
    draft = removeConversation(draft, IDS.c.gmRelease);
    expect(planSave(draft, base())).toEqual([
      { kind: 'removeConversation', id: IDS.c.gmRelease },
      { kind: 'setPreferred', conversationId: IDS.c.gmReview },
    ]);
  });

  it('adds a new conversation as preferred through the add call itself', () => {
    let draft = draftFromProject(project(IDS.gitManager), conversationsOf(IDS.gitManager));
    const added = addConversation(draft, U3, 'Fresh chat');
    if (!added.ok) throw new Error(added.message);
    draft = setPreferred(added.draft, added.key);
    const ops = planSave(draft, base());
    expect(ops).toEqual([{ kind: 'addConversation', key: added.key, url: U3.url, title: 'Fresh chat', makePreferred: true }]);
  });

  it('asks which environment new sessions start in only when the folders span several', () => {
    let draft = draftFromProject(project(IDS.dashboard), conversationsOf(IDS.dashboard));
    expect(new Set(draft.roots.map((r) => r.env)).size).toBe(2);
    draft = { ...draft, defaultEnv: 'wsl:Ubuntu' };
    expect(planSave(draft, { project: project(IDS.dashboard), conversations: conversationsOf(IDS.dashboard) })).toEqual([{ kind: 'update', patch: { defaultEnv: 'wsl:Ubuntu' } }]);
    const single = draftFromProject(project(IDS.gitManager), conversationsOf(IDS.gitManager));
    expect(planSave({ ...single, defaultEnv: 'posix' }, base())).toEqual([]);
  });
});

describe('runSave', () => {
  function fakeApi() {
    const calls: { name: string; input: unknown }[] = [];
    let counter = 0;
    const call = vi.fn(async (name: string, input?: unknown) => {
      calls.push({ name, input });
      if (name === 'projects.create') {
        const body = (input as { body: { roots: { path: string; env: string }[] } }).body;
        return { id: 'prj_new', roots: body.roots.map((r, i) => ({ id: `root_${i}`, ...r })) };
      }
      if (name === 'conversations.add') { counter += 1; return { id: `cnv_${counter}` }; }
      if (name === 'projects.addRoot') return { id: 'prj_x', roots: [{ id: 'root_added', path: (input as { body: { path: string } }).body.path, env: (input as { body: { env: string } }).body.env }] };
      return {};
    });
    return { api: { call } as unknown as ApiClient, calls, call };
  }

  it('creates the project, then its conversations, and reports what it made', async () => {
    const { api, calls } = fakeApi();
    let draft = { ...emptyDraft(), name: 'Billing' };
    const root = addRoot(draft, 'win', 'C:\\Dev\\Billing');
    if (root.ok) draft = root.draft;
    draft = { ...draft, ...pick(withConversations(U1)) };
    const progress = await runSave(api, planSave(draft, null), null);
    expect(calls.map((c) => c.name)).toEqual(['projects.create', 'conversations.add']);
    expect(progress.projectId).toBe('prj_new');
    expect(progress.rootIds[draft.roots[0].key]).toBe('root_0');
    expect(progress.conversationIds[draft.conversations[0].key]).toBe('cnv_1');
    expect(calls[1].input).toMatchObject({ params: { id: 'prj_new' }, body: { url: U1.url, makePreferred: true } });
  });

  it('stops at the first failure and says which step it was, keeping what was already made', async () => {
    const { api, call } = fakeApi();
    call.mockImplementation(async (name: string) => {
      if (name === 'projects.create') return { id: 'prj_new', roots: [] };
      throw new Error('ChatGPT address was refused');
    });
    const draft = { ...emptyDraft(), name: 'Billing', ...pick(withConversations(U1, U2)) };
    const failure = await runSave(api, planSave(draft, null), null).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SaveFailure);
    const f = failure as SaveFailure;
    expect(f.message).toBe('Could not add a conversation: ChatGPT address was refused');
    expect(f.progress.projectId).toBe('prj_new');
    expect(call).toHaveBeenCalledTimes(2); // create, then the first add; the second add never ran
  });
});

/** The conversation parts of a draft, to merge into another draft. */
function pick(d: ProjectDraft): Pick<ProjectDraft, 'conversations' | 'preferredKey'> {
  return { conversations: d.conversations, preferredKey: d.preferredKey };
}
