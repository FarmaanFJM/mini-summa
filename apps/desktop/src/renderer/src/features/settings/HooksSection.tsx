import type { EnvId, HookStatus } from '@minisumma/shared';
import { useState } from 'react';
import { useApp } from '../../app/runtime';
import { Button, EmptyState, Icon } from '../../ui';
import { Group } from './controls';
import { useEnvironments } from './ClaudeCodeSection';
import { HooksDialog } from './HooksDialog';
import { envName, hookSummary, runtimeWords } from './model';

/** Claude Code hooks, per environment. Nothing is written without reading the exact diff and agreeing to that file. */
export function HooksSection() {
  const stored = useApp((s) => s.hooks);
  const { state } = useEnvironments();
  const [flow, setFlow] = useState<{ env: EnvId; action: 'install' | 'uninstall' } | null>(null);

  // The store is live (hooks.changed); the environment list fills in environments the store has not heard about.
  const byEnv = new Map<string, HookStatus>(stored.map((h) => [h.env, h]));
  for (const e of state.envs ?? []) if (e.hooks && !byEnv.has(e.id)) byEnv.set(e.id, e.hooks);
  const rows = [...byEnv.values()];
  const claude = new Map((state.envs ?? []).map((e) => [e.id, e.claude.path !== null]));

  return (
    <div className="ms-set-page">
      <Group title="What installing does">
        <ul className="ms-set-points">
          <li>Mini-Summa edits only its own entries in Claude Code's user settings file. Your other settings and hooks are not touched.</li>
          <li>No repository file is touched, and no CLAUDE.md is needed.</li>
          <li>Sessions that Mini-Summa starts get their hooks automatically, so they work without installing anything. Installing adds capture for sessions you start yourself in a normal terminal.</li>
          <li>Claude Code reads hooks when a session starts, so sessions that are already running report only after they are restarted.</li>
          <li>Before anything is written you see the exact changes, and a backup of the file is saved first.</li>
        </ul>
      </Group>

      <Group title="Environments">
        {rows.length === 0 ? <EmptyState>{state.status === 'loading' ? 'Looking for Claude Code.' : 'No environment was found.'}</EmptyState> : (
          <ul className="ms-set-cards" aria-label="Hooks per environment">
            {rows.map((h) => (
              <li key={h.env} className="ms-set-card">
                <div className="ms-set-card__head">
                  <h3 className="ms-set-card__title">{envName(h.env)}</h3>
                  <span className="ms-set-card__state"><Icon name={h.installed && h.missingEvents.length === 0 && !h.duplicateRegistrations ? 'circle-check' : 'circle'} size={14} />{hookSummary(h)}</span>
                </div>
                <dl className="ms-x-kv" aria-label={`${envName(h.env)} hooks`}>
                  <dt>Settings file</dt><dd className="ms-mono ms-break">{h.settingsPath}</dd>
                  <dt>Runs with</dt><dd>{runtimeWords(h.runtime)}</dd>
                </dl>
                {h.issues.map((issue) => <p key={issue} className="ms-x-note">{issue}</p>)}
                {claude.get(h.env) === false ? <p className="ms-x-note">Claude Code was not found here, so hooks would have nothing to report on.</p> : null}
                <div className="ms-x-actions">
                  <Button variant={h.installed ? 'secondary' : 'secondary'} icon="eye" onClick={() => setFlow({ env: h.env, action: 'install' })}>{h.installed ? 'Review install again' : 'Review changes'}</Button>
                  {h.installed ? <Button variant="ghost" onClick={() => setFlow({ env: h.env, action: 'uninstall' })}>Review removal</Button> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Group>
      {flow ? <HooksDialog key={`${flow.env}-${flow.action}`} env={flow.env} action={flow.action} onClose={() => setFlow(null)} /> : null}
    </div>
  );
}
