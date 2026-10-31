// Project settings: the edit mode of the project dialog. There is no draft and no Save. Every change reaches the core the moment it
// is made, and the answer is shown where the change was made, so closing the dialog can never lose anything: before it closes it asks
// each field to finish what it holds, and it stays open (saying why beside the field) when a field cannot.
import { githubRepoUrl } from '@minisumma/shared';
import type { Project } from '@minisumma/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNative } from '../../app/native';
import { useApi, useApp, useRoute } from '../../app/runtime';
import { Button, Dialog, Field, TextInput, toast } from '../../ui';
import { ChatGptProjectSection } from './ChatGptProjectSection';
import { ConversationsSection } from './ConversationsSection';
import { FoldersSection } from './FoldersSection';
import { SettingsSection } from './parts';
import { checkName, NAME_MAX, readGithub } from './readings';
import { failureText, FlushProvider, useCommitText, useSavedFlag } from './useCommit';
import type { Flush, FlushRegistry } from './useCommit';

export interface ProjectSettingsProps {
  projectId: string;
  onClose(): void;
}

export function ProjectSettings({ projectId, onClose }: ProjectSettingsProps) {
  const project = useApp((s) => s.projects.find((p) => p.id === projectId));
  const api = useApi();
  const route = useRoute();
  const native = useNative();
  const maximized = useApp((s) => s.settings?.layout.maximized ?? null);
  const embedded = useApp((s) => (s.settings?.chatgpt.mode ?? 'embedded') === 'embedded') && native.hasEmbeddedChatGpt;

  const flushes = useRef(new Set<Flush>());
  const registry = useMemo<FlushRegistry>(() => ({
    register(flush) { flushes.current.add(flush); return () => { flushes.current.delete(flush); }; },
  }), []);
  const [closing, setClosing] = useState(false);
  const finishing = useRef(false);

  // A project that was deleted while its settings were open has nothing left to show.
  useEffect(() => { if (!project) onClose(); }, [project, onClose]);

  /** Asks every field to finish. True when nothing is left behind. */
  const settle = useCallback(async (): Promise<boolean> => {
    const results = await Promise.all([...flushes.current].map((flush) => flush()));
    return results.every(Boolean);
  }, []);

  /** Closes, once every field has finished. A field that cannot keeps the dialog open and says why next to itself. */
  const finish = useCallback(async (after?: () => void) => {
    if (finishing.current) return;
    finishing.current = true;
    setClosing(true);
    try {
      if (await settle()) {
        onClose();
        after?.();
      }
    } finally {
      finishing.current = false;
      setClosing(false);
    }
  }, [settle, onClose]);

  const openChatGptProject = useCallback(() => {
    const link = project?.chatgptProject;
    if (!project || !link) return;
    void finish(() => {
      route.selectProject(project.id);
      // A maximised Claude pane hides the ChatGPT one.
      if (maximized === 'claude') void api.call('settings.update', { body: { layout: { maximized: null } } }).catch(() => {});
      const failed = (err: unknown) => toast({ title: 'Could not open ChatGPT', body: failureText(err), kind: 'error' });
      // In the window the ChatGPT pane owns what the view shows, so it is asked (and loads the page itself); otherwise it is the browser's.
      if (embedded) route.openChatGptProject(project.id);
      else void native.shell.openExternal(link.url).catch(failed);
    });
  }, [project, finish, route, maximized, api, embedded, native]);

  if (!project) return null;
  return (
    <FlushProvider value={registry}>
      <Dialog
        open
        onClose={() => { void finish(); }}
        title={`${project.name} settings`}
        size="lg"
        busy={closing}
        footer={<Button variant="primary" loading={closing} onClick={() => { void finish(); }}>Done</Button>}
      >
        <div className="ms-pj-form">
          <NameSection project={project} />
          <ChatGptProjectSection project={project} onOpen={openChatGptProject} />
          <GithubSection project={project} />
          <FoldersSection project={project} />
          <ConversationsSection project={project} />
        </div>
      </Dialog>
    </FlushProvider>
  );
}

function NameSection({ project }: { project: Project }) {
  const api = useApi();
  const { saved, flash } = useSavedFlag();
  const field = useCommitText<string>({
    saved: project.name,
    check: (text) => {
      const read = checkName(text);
      return read.ok ? { ok: true, value: read.value, shown: read.value } : { ok: false, message: read.message, quiet: text.trim() === '' };
    },
    apply: async (name) => { await api.call('projects.update', { params: { id: project.id }, body: { name } }); },
    onSaved: flash,
  });
  return (
    <SettingsSection title="Name" saved={saved}>
      <Field label="Name" error={field.error ?? undefined} className="ms-pj-bare">
        <TextInput {...field.inputProps} maxLength={NAME_MAX} autoComplete="off" />
      </Field>
    </SettingsSection>
  );
}

function GithubSection({ project }: { project: Project }) {
  const api = useApi();
  const native = useNative();
  const { saved, flash } = useSavedFlag();
  const [problem, setProblem] = useState<string | null>(null);
  const field = useCommitText<string | null>({
    saved: project.githubRepo ?? '',
    check: (text) => {
      const read = readGithub(text);
      if (read.kind === 'invalid') return { ok: false, message: read.message };
      // Clearing the field removes the repository.
      return read.kind === 'empty' ? { ok: true, value: null, shown: '' } : { ok: true, value: read.value, shown: read.value };
    },
    apply: async (githubRepo) => { await api.call('projects.update', { params: { id: project.id }, body: { githubRepo } }); },
    onSaved: flash,
  });
  const reading = readGithub(field.text);
  const repo = project.githubRepo;

  const openOnGithub = async () => {
    if (!repo) return;
    setProblem(null);
    try {
      await native.shell.openExternal(githubRepoUrl(repo));
    } catch (err) {
      setProblem(`Could not open GitHub. ${failureText(err)}`);
    }
  };

  return (
    <SettingsSection title="GitHub repository" saved={saved}>
      <Field
        label="GitHub repository"
        error={field.error ?? problem ?? undefined}
        hint={reading.kind === 'ok' && reading.changed ? `Will be saved as ${reading.value}.` : undefined}
        className="ms-pj-bare"
      >
        <div className="ms-pj-inline">
          <TextInput {...field.inputProps} placeholder="owner/repo" spellCheck={false} autoComplete="off" />
          {repo ? <Button icon="external" onClick={() => { void openOnGithub(); }}>Open on GitHub</Button> : null}
        </div>
      </Field>
    </SettingsSection>
  );
}
