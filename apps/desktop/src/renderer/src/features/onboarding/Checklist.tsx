import type { EnvironmentInfo } from '@minisumma/shared';
import './onboarding.css';
import { useMemo } from 'react';
import { useApp, useRoute, useUi } from '../../app/runtime';
import { useNative } from '../../app/native';
import { activeProjects } from '../../app/selectors';
import { Button, Icon } from '../../ui';
import { useChatGptView } from '../settings/ChatGptSection';
import { InstallHelp, useEnvironments } from '../settings/ClaudeCodeSection';
import { useSettings } from '../settings/useSettings';
import type { SettingsHandle } from '../settings/useSettings';
import { deriveSteps, isComplete } from './model';
import type { Step, StepFacts } from './model';
import { useOnboarding } from './state';

type Environments = ReturnType<typeof useEnvironments>;

export interface SetupState {
  facts: StepFacts;
  steps: Step[];
  environments: Environments;
}

/** Everything the checklist reads, gathered once: the same facts feed the ticks, the actions and whether to show it at all. */
export function useSetup(): SetupState {
  const native = useNative();
  const environments = useEnvironments();
  const projects = useApp((s) => s.projects);
  const conversations = useApp((s) => s.conversations);
  const sessions = useApp((s) => s.sessions);
  const hooks = useApp((s) => s.hooks);
  const settings = useApp((s) => s.settings);
  const embedded = (settings?.chatgpt.mode ?? 'embedded') === 'embedded' && native.hasEmbeddedChatGpt;
  const view = useChatGptView(embedded);
  const { state } = environments;

  const facts = useMemo<StepFacts>(() => ({
    envs: state.status === 'ready' ? state.envs : state.status === 'error' ? state.envs : null,
    envError: state.status === 'error' ? state.error : null,
    projects: activeProjects(projects),
    conversations,
    sessions,
    hooks,
    settings,
    hasEmbeddedView: native.hasEmbeddedChatGpt,
    view,
  }), [state, projects, conversations, sessions, hooks, settings, native.hasEmbeddedChatGpt, view]);

  const steps = useMemo(() => deriveSteps(facts), [facts]);
  return { facts, steps, environments };
}

function ClaudeHelp({ envs }: { envs: EnvironmentInfo[] | null }) {
  const target = envs?.find((e) => e.available && e.claude.path === null);
  if (envs !== null && envs.length === 0) return <p className="ms-x-note">No environment was found on this PC.</p>;
  if (!target) return null;
  return <InstallHelp env={target} />;
}

function StepActions({ step, next, setup, save }: { step: Step; next: boolean; setup: SetupState; save: SettingsHandle['save'] }) {
  const route = useRoute();
  const openProjectDialog = useUi((s) => s.openProjectDialog);
  const first = setup.facts.projects[0];
  const emphasis = next ? 'primary' : 'secondary';
  // A session runs in a folder: the step points at a project that has one, and when none has, offers to give the first one a folder.
  const withFolder = setup.facts.projects.find((p) => p.roots.length > 0);

  switch (step.id) {
    case 'claude':
      return step.done ? null : (
        <>
          <ClaudeHelp envs={setup.facts.envs} />
          <div className="ms-x-actions">
            <Button variant={emphasis} icon="refresh" loading={setup.environments.refreshing} onClick={() => { void setup.environments.refresh(true); }}>Refresh</Button>
          </div>
        </>
      );
    case 'project':
      return step.done ? null : (
        <div className="ms-x-actions"><Button variant={emphasis} icon="plus" onClick={() => openProjectDialog({ mode: 'create' })}>Create project</Button></div>
      );
    case 'conversation': {
      if (step.done || !first) return null;
      const lacking = setup.facts.projects.find((p) => !setup.facts.conversations.some((c) => c.projectId === p.id)) ?? first;
      return (
        <div className="ms-x-actions"><Button variant={emphasis} onClick={() => openProjectDialog({ mode: 'edit', projectId: lacking.id })}>Add a conversation to {lacking.name}</Button></div>
      );
    }
    case 'chatgpt':
      return (
        <div className="ms-x-actions">
          {!step.done ? <Button variant={emphasis} onClick={() => { void save({ chatgpt: { mode: 'external' } }); }}>Use my browser</Button> : null}
          <Button variant="ghost" onClick={() => route.go({ view: 'settings', section: 'chatgpt' })}>ChatGPT settings</Button>
        </div>
      );
    case 'hooks':
      return (
        <div className="ms-x-actions"><Button onClick={() => route.go({ view: 'settings', section: 'hooks' })}>{step.done ? 'Review hooks' : 'Review the changes'}</Button></div>
      );
    case 'session':
      if (step.done || !first) return null;
      return withFolder ? (
        <div className="ms-x-actions"><Button variant={emphasis} onClick={() => route.selectProject(withFolder.id)}>Open {withFolder.name}</Button></div>
      ) : (
        <div className="ms-x-actions"><Button variant={emphasis} onClick={() => openProjectDialog({ mode: 'edit', projectId: first.id })}>Add a folder to {first.name}</Button></div>
      );
    default:
      return null;
  }
}

/**
 * The steps with their ticks. A tick is a fact the core reports, with the words that say why. In the compact form a finished
 * step is only its title, so what is left to do stays in view.
 */
export function Checklist({ setup, compact = false }: { setup: SetupState; compact?: boolean }) {
  const { save } = useSettings();
  const next = setup.steps.find((s) => !s.done && !s.optional);
  return (
    <ol className="ms-onb-steps" aria-label="Setup steps" data-compact={compact ? '' : undefined}>
      {setup.steps.map((step) => (
        <li key={step.id} className="ms-onb-step" data-done={step.done ? '' : undefined}>
          <span className="ms-onb-step__mark" aria-hidden="true"><Icon name={step.done ? 'circle-check' : 'circle'} size={18} /></span>
          <div className="ms-onb-step__body">
            <h3 className="ms-onb-step__title">
              <span className="ms-x-hidden">{step.done ? 'Done: ' : 'To do: '}</span>
              {step.title}{step.optional ? <span className="ms-onb-step__optional"> (optional)</span> : null}
            </h3>
            {compact && step.done ? null : (
              <>
                <p className="ms-x-note">{step.detail}</p>
                <StepActions step={step} next={next?.id === step.id} setup={setup} save={save} />
              </>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * The checklist inside Settings, always available. It also says where the on-screen copy stands and brings it back, which is
 * how a person who hid it finds it again.
 */
export function SetupChecklist() {
  const setup = useSetup();
  const prefs = useOnboarding();
  const noProjects = useApp((s) => s.projects.length === 0);
  const ready = setup.facts.envs !== null;
  const complete = ready && isComplete(setup.steps);
  const onScreen = !prefs.dismissed && (prefs.seenEmpty || noProjects);

  return (
    <div className="ms-x-stack">
      <Checklist setup={setup} />
      {complete ? (
        <p className="ms-x-note">Every step that matters is done.</p>
      ) : onScreen ? (
        <p className="ms-x-note">This checklist is also shown on the start screen until it is finished or you hide it.</p>
      ) : (
        <div className="ms-x-actions">
          <Button onClick={prefs.reopen}>Show the checklist on the start screen again</Button>
        </div>
      )}
    </div>
  );
}
