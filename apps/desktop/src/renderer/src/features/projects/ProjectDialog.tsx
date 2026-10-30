import { envLabel } from '@minisumma/shared';
import { useId, useMemo, useState } from 'react';
import { useApi, useApp, useAppStore, useRoute, useUi } from '../../app/runtime';
import { Button, Dialog, Field, Section, Select, TextInput, toast } from '../../ui';
import { ConversationsEditor } from './ConversationsEditor';
import {
  distinctEnvs, draftFromProject, emptyDraft, normalizeGithubRepo, planSave, validateDraft,
} from './projectDraft';
import type { ProjectDraft } from './projectDraft';
import { RootsEditor } from './RootsEditor';
import { runSave, SaveFailure } from './saveProject';
import type { SaveProgress } from './saveProject';

/** Renders the create/edit dialog when the ui store asks for it. Mounted once by the shell. */
export function ProjectDialog() {
  const state = useUi((s) => s.projectDialog);
  const close = useUi((s) => s.closeProjectDialog);
  if (!state) return null;
  return <ProjectForm key={state.mode === 'edit' ? state.projectId : 'create'} mode={state.mode} projectId={state.mode === 'edit' ? state.projectId : null} onClose={close} />;
}

interface FormProps { mode: 'create' | 'edit'; projectId: string | null; onClose: () => void }

function ProjectForm({ mode: initialMode, projectId: initialProjectId, onClose }: FormProps) {
  const api = useApi();
  const store = useAppStore();
  const route = useRoute();
  const formId = useId();

  // A dialog that switched from create to edit after a partial failure keeps editing the project it just made.
  const [projectId, setProjectId] = useState(initialProjectId);
  const mode = projectId ? 'edit' : initialMode;
  const [draft, setDraft] = useState<ProjectDraft>(() => {
    const project = initialProjectId ? store.getState().projects.find((p) => p.id === initialProjectId) : null;
    return project ? draftFromProject(project, store.getState().conversations) : emptyDraft();
  });
  const [initial] = useState(draft);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  const errors = validateDraft(draft);
  const hasErrors = Boolean(errors.name || errors.githubRepo);
  const envs = distinctEnvs(draft.roots);
  const repo = normalizeGithubRepo(draft.githubRepo);
  const projectName = useApp((s) => s.projects.find((p) => p.id === projectId)?.name);

  const adopt = (progress: SaveProgress) => {
    // Keep what was created so a retry does not create it twice.
    setProjectId(progress.projectId);
    setDraft((d) => ({
      ...d,
      roots: d.roots.map((r) => (r.id === null && progress.rootIds[r.key] ? { ...r, id: progress.rootIds[r.key] } : r)),
      conversations: d.conversations.map((c) => (c.id === null && progress.conversationIds[c.key] ? { ...c, id: progress.conversationIds[c.key] } : c)),
    }));
  };

  const save = async () => {
    setTouched(true);
    if (hasErrors || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      // The plan is made against the core's state right now, so a retry sends only what is still missing.
      const state = store.getState();
      const current = projectId ? state.projects.find((p) => p.id === projectId) : null;
      const ops = planSave(draft, current ? { project: current, conversations: state.conversations } : null);
      const progress = await runSave(api, ops, projectId);
      if (mode === 'create' && progress.projectId) route.selectProject(progress.projectId);
      if (ops.length === 0 && mode === 'edit') toast({ title: 'No changes to save' });
      onClose();
    } catch (err) {
      if (err instanceof SaveFailure) {
        adopt(err.progress);
        setSaveError(err.message);
      } else setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const title = mode === 'create' ? 'New project' : `Edit ${projectName ?? 'project'}`;
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="lg"
      busy={saving}
      dismissOnBackdrop={!dirty}
      footer={(
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" loading={saving}>{mode === 'create' ? 'Create project' : 'Save changes'}</Button>
        </>
      )}
    >
      <form id={formId} className="ms-form" noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Section title="Project" level={3}>
          <div className="ms-grid-2">
            <Field label="Name" required error={touched ? errors.name : undefined}>
              <TextInput value={draft.name} maxLength={120} autoComplete="off" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field
              label="GitHub repository"
              error={touched || draft.githubRepo !== '' ? errors.githubRepo : undefined}
              hint={repo.ok && repo.changed && repo.value ? `Will be saved as ${repo.value}.` : undefined}
            >
              <TextInput
                value={draft.githubRepo}
                placeholder="owner/repo"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setDraft({ ...draft, githubRepo: e.target.value })}
              />
            </Field>
          </div>
        </Section>

        <Section title="Repository folders" level={3}>
          <RootsEditor draft={draft} onChange={setDraft} />
          {envs.length > 1 ? (
            <Field label="New sessions start in">
              <Select
                value={draft.defaultEnv && envs.includes(draft.defaultEnv) ? draft.defaultEnv : envs[0]}
                onChange={(env) => setDraft({ ...draft, defaultEnv: env })}
                options={envs.map((e) => ({ value: e, label: envLabel(e) }))}
              />
            </Field>
          ) : null}
        </Section>

        <Section title="ChatGPT conversations" level={3}>
          <ConversationsEditor draft={draft} onChange={setDraft} />
        </Section>

        {saveError ? <p className="ms-dialog__error" role="alert">{saveError}</p> : null}
      </form>
    </Dialog>
  );
}
