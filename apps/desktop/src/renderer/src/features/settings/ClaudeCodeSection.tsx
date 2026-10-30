import type { EnvironmentInfo } from '@minisumma/shared';
import { useCallback, useEffect, useState } from 'react';
import { useApi, useRoute } from '../../app/runtime';
import { Button, EmptyState, Icon } from '../../ui';
import { errorText } from '../reports/support';
import { Group } from './controls';
import { hookSummary, installGuidance, runtimeWords } from './model';

export type EnvState = { status: 'loading'; envs: EnvironmentInfo[] | null; error: null } | { status: 'ready'; envs: EnvironmentInfo[]; error: null } | { status: 'error'; envs: EnvironmentInfo[] | null; error: string };

/** The environments Mini-Summa found (Windows, each WSL distribution, Linux), with Claude Code and the Node runtime in each. */
export function useEnvironments(): { state: EnvState; refresh: (rescan: boolean) => Promise<void>; refreshing: boolean } {
  const api = useApi();
  const [state, setState] = useState<EnvState>({ status: 'loading', envs: null, error: null });
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async (rescan: boolean) => {
    setRefreshing(true);
    try {
      const envs = await api.call('environments.list', { query: rescan ? { refresh: true } : {} });
      setState({ status: 'ready', envs, error: null });
    } catch (err) {
      setState((s) => ({ status: 'error', envs: s.envs, error: errorText(err) }));
    } finally {
      setRefreshing(false);
    }
  }, [api]);
  useEffect(() => { void refresh(false); }, [refresh]);
  return { state, refresh, refreshing };
}

export const claudeFound = (e: EnvironmentInfo): boolean => e.available && e.claude.path !== null;

/** Exact install commands for an environment where Claude Code was not found. */
export function InstallHelp({ env }: { env: EnvironmentInfo }) {
  return (
    <div className="ms-set-install">
      <p className="ms-x-note">Install Claude Code in {env.label}, then press Refresh. Run one of these{env.id === 'win' ? '' : ' inside that environment'}:</p>
      <ul className="ms-set-commands">
        {installGuidance(env.id).map((c) => (
          <li key={c.command}><span className="ms-x-note">In {c.where}:</span><code className="ms-x-text ms-mono">{c.command}</code></li>
        ))}
      </ul>
    </div>
  );
}

export function ClaudeCodeSection() {
  const route = useRoute();
  const { state, refresh, refreshing } = useEnvironments();

  return (
    <div className="ms-set-page">
      <Group
        title="Environments"
        note="Windows, each WSL distribution and Linux are separate: each has its own Claude Code, its own settings and its own sessions."
        actions={<Button size="sm" icon="refresh" loading={refreshing} onClick={() => { void refresh(true); }}>Refresh</Button>}
      >
        {state.status === 'loading' ? (
          <div className="ms-skeleton-list ms-skeleton-list--wide" aria-busy="true" aria-label="Looking for Claude Code">{[0, 1].map((i) => <div key={i} className="ms-skeleton-row" />)}</div>
        ) : state.status === 'error' && !state.envs ? (
          <EmptyState tone="error" action={<Button onClick={() => { void refresh(true); }}>Try again</Button>}>Mini-Summa could not look for Claude Code. {state.error}</EmptyState>
        ) : (
          <>
            {state.status === 'error' ? <p className="ms-x-error" role="alert">The list could not be refreshed: {state.error}</p> : null}
            {state.envs?.length === 0 ? <EmptyState>No environment was found on this PC.</EmptyState> : null}
            <ul className="ms-set-cards" aria-label="Environments">
              {state.envs?.map((env) => {
                const found = claudeFound(env);
                return (
                  <li key={env.id} className="ms-set-card">
                    <div className="ms-set-card__head">
                      <h3 className="ms-set-card__title">{env.label}</h3>
                      <span className="ms-set-card__state"><Icon name={found ? 'circle-check' : 'circle-alert'} size={14} />{found ? 'Claude Code found' : env.available ? 'Claude Code not found' : 'Not reachable'}</span>
                    </div>
                    {found ? (
                      <dl className="ms-x-kv" aria-label={`${env.label} details`}>
                        <dt>Claude Code</dt><dd><span className="ms-mono ms-break">{env.claude.path}</span>{env.claude.version ? `, version ${env.claude.version}` : ''}</dd>
                        <dt>Hooks run with</dt><dd>{env.hooks ? runtimeWords(env.hooks.runtime) : env.node.path ? `Node.js ${env.node.version ?? ''} at ${env.node.path}` : 'Not known yet'}</dd>
                        <dt>Settings folder</dt><dd className="ms-mono ms-break">{env.configDir ?? 'Not found'}</dd>
                        {env.hooks ? (<><dt>Hooks</dt><dd>{hookSummary(env.hooks)} <button type="button" className="ms-x-linkbtn" onClick={() => route.go({ section: 'hooks' })}>Review hooks</button></dd></>) : null}
                      </dl>
                    ) : (
                      <>
                        <p className="ms-x-error">{env.claude.error ?? (env.available ? 'Claude Code was not found.' : 'Mini-Summa cannot reach this environment right now.')}</p>
                        {env.available ? <InstallHelp env={env} /> : <p className="ms-x-note">Start it (for a WSL distribution, open it once), then press Refresh.</p>}
                      </>
                    )}
                    {env.notes.map((n) => <p key={n} className="ms-x-note">{n}</p>)}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Group>
    </div>
  );
}
