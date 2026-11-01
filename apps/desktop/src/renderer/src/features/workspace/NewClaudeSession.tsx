import { MAX_PROMPT_CHARS, envLabel } from '@minisumma/shared';
import type { CloneCheck, CloudDispatch, CloudPreflight, Project, PromptDeliveryPlan, SessionView, TempWorkspace } from '@minisumma/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNative } from '../../app/native';
import { useApi } from '../../app/runtime';
import { Button, Checkbox, Dialog, Field, Radio, Select, Spinner, TextArea, TextInput, toast } from '../../ui';
import { DispatchStatus } from './DispatchStatus';
import { MODE_HELP, MODE_LABEL, draftStore, emptyDraft, sessionModes } from './sessionModes';
import type { SessionMode } from './sessionModes';
import { usePoll } from './usePoll';

export interface NewClaudeSessionProps {
  project: Project;
  open: boolean;
  initialMode: SessionMode;
  starting: boolean;
  onClose: () => void;
  /** Start Claude Code in a folder of the project, or in a temporary workspace. */
  onStartLocal: (o: { rootId?: string; workspaceId?: string; name: string }) => Promise<SessionView | null>;
  /** The old way: open the start page of Claude Code on the web in the Cloud tab, with nothing sent. */
  onOpenWebStart: () => void;
  /** Show a session page in the Cloud tab. */
  onShowCloudPage: (url: string) => void;
}

const MODES: SessionMode[] = ['cloud', 'temporary', 'existing'];

/**
 * The one place a Claude session is started from. It asks for the way to run it first (cloud, temporary local, existing local), then
 * only what that way needs. It never starts a way the person did not choose, and a way that cannot start says why.
 */
export function NewClaudeSession(props: NewClaudeSessionProps) {
  const { project, open } = props;
  const saved = draftStore.get(project.id);
  const [mode, setMode] = useState<SessionMode>(props.initialMode);
  // Opened for a specific mode (a menu item): that mode wins over the one remembered.
  useEffect(() => { if (open) setMode(props.initialMode); }, [open, props.initialMode]);
  const modes = sessionModes(project);
  const draft = useRef(saved ?? emptyDraft(props.initialMode));
  const [, rerender] = useState(0);
  const update = (patch: Partial<typeof draft.current>) => {
    draft.current = { ...draft.current, ...patch, mode };
    draftStore.set(project.id, draft.current);
    rerender((n) => n + 1);
  };
  const [dispatch, setDispatch] = useState<CloudDispatch | null>(null);
  const api = useApi();
  usePoll(async () => { if (dispatch) setDispatch(await api.call('cloud.dispatchGet', { params: { id: dispatch.id } })); },
    open && dispatch !== null && (dispatch.running || dispatch.phase === 'submitting' || dispatch.phase === 'preparing'), 1000);

  const close = () => { setDispatch(null); props.onClose(); };

  return (
    <Dialog open={open} onClose={close} title="New Claude session" size="lg" className="ms-newsession" busy={props.starting}>
      {dispatch ? (
        <DispatchStatus
          projectId={project.id}
          dispatch={dispatch}
          onChange={setDispatch}
          onShowInCloudTab={(url) => { props.onShowCloudPage(url); close(); }}
          onDone={() => { draftStore.clear(project.id); draft.current = emptyDraft(mode); close(); }}
        />
      ) : (
        <>
          <div role="radiogroup" aria-label="Where Claude runs" className="ms-modes">
            {MODES.map((m) => (
              <div key={m} className="ms-mode" data-selected={mode === m || undefined} data-disabled={!modes[m].available || undefined}>
                <Radio
                  name="claude-mode"
                  checked={mode === m}
                  disabled={!modes[m].available}
                  onChange={() => setMode(m)}
                  label={(
                    <span className="ms-mode__text">
                      <span className="ms-mode__name">{MODE_LABEL[m]}</span>
                      <span className="ms-mode__help">{modes[m].available ? MODE_HELP[m] : `${MODE_HELP[m]} ${modes[m].reason}`}</span>
                    </span>
                  )}
                />
              </div>
            ))}
          </div>
          {mode === 'cloud' && modes.cloud.available ? (
            <CloudForm {...props} draft={draft.current} update={update} onDispatched={setDispatch} />
          ) : mode === 'temporary' && modes.temporary.available ? (
            <TemporaryForm {...props} draft={draft.current} update={update} onClose={close} />
          ) : mode === 'existing' && modes.existing.available ? (
            <ExistingForm {...props} draft={draft.current} update={update} onClose={close} />
          ) : null}
        </>
      )}
    </Dialog>
  );
}

type FormProps = NewClaudeSessionProps & { draft: ReturnType<typeof emptyDraft>; update: (p: Partial<ReturnType<typeof emptyDraft>>) => void };

// ---------------------------------------------------------------------------------------------------------------
// Cloud

function CloudForm({ project, draft, update, onDispatched, onOpenWebStart, onClose }: FormProps & { onDispatched: (d: CloudDispatch) => void }) {
  const api = useApi();
  const roots = useMemo(() => project.roots.slice().sort((a, b) => a.position - b.position), [project.roots]);
  const rootId = draft.rootId && roots.some((r) => r.id === draft.rootId) ? draft.rootId : roots[0]?.id ?? null;
  const [pre, setPre] = useState<CloudPreflight | null>(null);
  const [preError, setPreError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PromptDeliveryPlan | null>(null);
  const [ack, setAck] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPre(null); setPreError(null);
    api.call('cloud.preflight', { params: { id: project.id }, query: rootId ? { rootId } : {} })
      .then((p) => { if (!cancelled) setPre(p); }, (e: unknown) => { if (!cancelled) setPreError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [api, project.id, rootId]);

  // What the CLI can carry is asked of the core (it knows the launcher and the platform) a moment after typing stops.
  useEffect(() => {
    if (draft.prompt.trim() === '') { setPlan(null); return undefined; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.call('cloud.plan', { body: { prompt: draft.prompt } }).then((p) => { if (!cancelled) setPlan(p); }, () => { if (!cancelled) setPlan(null); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [api, draft.prompt]);

  const needsBrowser = plan?.method === 'clipboard_browser';
  const tooLong = draft.prompt.length > MAX_PROMPT_CHARS;
  const blockers = pre?.blockers ?? [];
  const ready = pre !== null && blockers.length === 0 && draft.prompt.trim() !== '' && !tooLong && ack && plan !== null && (!needsBrowser || browser);

  const send = async () => {
    setSending(true); setError(null);
    try {
      const d = await api.call('cloud.dispatch', {
        body: { projectId: project.id, prompt: draft.prompt, rootId, title: draft.title.trim() || null, acknowledgedLocalContent: ack, useBrowserFallback: needsBrowser && browser },
      });
      onDispatched(d);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSending(false); }
  };

  return (
    <div className="ms-newform">
      <Field label="Task for Claude" hint="Paste the full prompt from ChatGPT or type it. Nothing is shortened or sent anywhere until you press the button.">
        <TextArea
          rows={10}
          className="ms-composer"
          value={draft.prompt}
          spellCheck={false}
          placeholder="Paste or write the task"
          onChange={(e) => update({ prompt: e.target.value })}
        />
      </Field>
      <p className="ms-newform__count" aria-live="polite">
        {draft.prompt.length.toLocaleString('en-US')} characters
        {tooLong ? `. The limit is ${MAX_PROMPT_CHARS.toLocaleString('en-US')}. Mini-Summa will not cut it; split the task.` : ''}
      </p>

      {plan ? (
        needsBrowser ? (
          <div className="ms-notice" data-tone="attention" role="status">
            <span className="ms-notice__text">
              {plan.reason} Mini-Summa will not shorten it. It can copy the whole prompt and open claude.ai/code with the repository chosen; you paste it there and submit.
            </span>
          </div>
        ) : (
          <p className="ms-newform__fine">The whole prompt is passed to the Claude CLI exactly as written.</p>
        )
      ) : null}
      {needsBrowser ? <Checkbox checked={browser} onChange={setBrowser} label="Copy the prompt and open claude.ai/code in my browser" /> : null}

      <dl className="ms-facts ms-newform__facts">
        <dt>Repository</dt><dd className="ms-mono ms-truncate">{project.githubRepo}</dd>
        {roots.length > 1 ? (
          <>
            <dt>Folder</dt>
            <dd><Select value={rootId} onChange={(v) => update({ rootId: v })} options={roots.map((r) => ({ value: r.id, label: r.path, description: envLabel(r.env) }))} /></dd>
          </>
        ) : null}
        <dt>Branch</dt>
        <dd>{pre?.local?.branch ?? (pre ? 'The default branch of the repository' : '...')}{pre?.local?.upstream ? <span className="ms-newform__quiet">{` (tracks ${pre.local.upstream})`}</span> : null}</dd>
        <dt>Claude Code</dt>
        <dd>
          {pre ? (pre.cli.found ? `${pre.cli.version ?? 'installed'}${pre.auth.state === 'logged_in' ? ', signed in' : pre.auth.state === 'logged_out' ? ', not signed in' : ', sign-in not confirmed'}` : 'not found') : <Spinner />}
        </dd>
      </dl>
      <Field label="Title (optional)"><TextInput value={draft.title} maxLength={120} autoComplete="off" onChange={(e) => update({ title: e.target.value })} /></Field>

      {preError ? <div className="ms-notice" data-tone="error" role="alert"><span className="ms-notice__text">{preError}</span></div> : null}
      {blockers.map((b) => <div key={b} className="ms-notice" data-tone="error" role="alert"><span className="ms-notice__text">{b}</span></div>)}
      {pre && pre.warnings.length > 0 ? (
        <ul className="ms-newform__warnings">{pre.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      ) : null}
      <Checkbox
        checked={ack}
        onChange={setAck}
        label="I understand this runs on Anthropic's servers from GitHub, not from my working tree, and that Claude Code may upload local repository content."
      />
      {error ? <div className="ms-notice" data-tone="error" role="alert"><span className="ms-notice__text">{error}</span></div> : null}

      <div className="ms-newform__foot">
        <button type="button" className="ms-ws-link" onClick={() => { onOpenWebStart(); onClose(); }}>Start in Claude Code on the web instead</button>
        <Button variant="primary" icon="cloud" loading={sending} disabled={!ready} onClick={() => { void send(); }}>
          {needsBrowser ? 'Copy and open claude.ai/code' : 'Send to Claude cloud'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Temporary local session

function TemporaryForm({ project, draft, update, starting, onStartLocal, onClose }: FormProps) {
  const api = useApi();
  const native = useNative();
  const [check, setCheck] = useState<CloneCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [existing, setExisting] = useState<TempWorkspace[]>([]);
  const [reuse, setReuse] = useState<string>('new');
  const [confirmed, setConfirmed] = useState(false);
  const [work, setWork] = useState<TempWorkspace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.call('workspaces.check', { params: { id: project.id } }).then((c) => { if (!cancelled) setCheck(c); }, (e: unknown) => { if (!cancelled) setCheckError(e instanceof Error ? e.message : String(e)); });
    api.call('workspaces.list', { params: { id: project.id } }).then((l) => { if (!cancelled) setExisting(l.filter((w) => w.purpose === 'session' && w.status === 'ready')); }, () => undefined);
    return () => { cancelled = true; };
  }, [api, project.id]);

  usePoll(async () => { if (work) setWork(await api.call('workspaces.get', { params: { id: work.id } })); }, work !== null && work.status === 'cloning', 1000);

  // When the download is ready the session starts in it. A failure stays on screen with its reason and a retry.
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!work || work.status !== 'ready' || started.current === work.id) return;
    started.current = work.id;
    void run(work.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work]);

  const run = async (workspaceId: string) => {
    const s = await onStartLocal({ workspaceId, name: draft.title.trim() });
    if (!s) return;
    if (draft.prompt.trim() !== '') {
      try { await native.clipboard.writeText(draft.prompt); toast({ title: 'Prompt copied', body: 'Paste it into the terminal when Claude Code is ready.', kind: 'success', durationMs: 5000 }); }
      catch { toast({ title: 'The prompt could not be copied', body: 'It is still in the box above.', kind: 'error' }); }
    }
    draftStore.clear(project.id);
    onClose();
  };

  const begin = async () => {
    setBusy(true); setError(null);
    try {
      if (reuse !== 'new') { await run(reuse); return; }
      const created = await api.call('workspaces.create', {
        params: { id: project.id },
        body: { confirmed, branch: draft.branch, featureBranch: draft.featureBranch.trim() || null },
      });
      setWork(created);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const retry = async () => { if (work) { started.current = null; setWork(await api.call('workspaces.retry', { params: { id: work.id } })); } };
  const cancel = async () => { if (work) setWork(await api.call('workspaces.cancel', { params: { id: work.id } })); };

  const branches = check?.branches ?? [];
  const chosenBranch = draft.branch ?? check?.defaultBranch ?? null;
  const gb = (kb: number) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(kb / 1024))} MB`);
  const blockers = check?.blockers ?? [];
  const canBegin = (reuse !== 'new' || (check !== null && blockers.length === 0 && (!check.needsConfirmation || confirmed))) && !busy && !starting && !work;

  return (
    <div className="ms-newform">
      <Field label="Prompt (optional)" hint="If you add one it is copied to your clipboard when Claude Code starts. You paste it into the terminal yourself.">
        <TextArea rows={6} className="ms-composer" value={draft.prompt} spellCheck={false} placeholder="Paste or write the task" onChange={(e) => update({ prompt: e.target.value })} />
      </Field>

      {existing.length > 0 ? (
        <Field label="Workspace">
          <Select value={reuse} onChange={setReuse} options={[
            { value: 'new', label: 'Download a new copy' },
            ...existing.map((w) => ({ value: w.id, label: `${w.featureBranch ?? w.branch ?? 'checkout'}, ${new Date(w.createdAt).toLocaleDateString()}`, description: 'Continue in this saved checkout' })),
          ]} />
        </Field>
      ) : null}

      {reuse === 'new' ? (
        <>
          {!check && !checkError ? <p className="ms-newform__fine"><Spinner /> Checking GitHub access, size and free disk space</p> : null}
          {checkError ? <div className="ms-notice" data-tone="error" role="alert"><span className="ms-notice__text">{checkError}</span></div> : null}
          {check ? (
            <>
              <dl className="ms-facts ms-newform__facts">
                <dt>Repository</dt><dd className="ms-mono ms-truncate">{check.repo}</dd>
                <dt>GitHub access</dt><dd>{check.access === 'ok' ? 'Reachable with your Git login' : check.accessNote ?? 'Unknown'}</dd>
                <dt>Size</dt><dd>{check.reportedSizeKb !== null ? `About ${gb(check.reportedSizeKb)} (approximate)` : 'Unknown'}</dd>
                <dt>Free space</dt><dd>{check.freeBytes !== null ? gb(check.freeBytes / 1024) : 'Unknown'}</dd>
              </dl>
              {branches.length > 0 ? (
                <Field label="Starting branch">
                  <Select value={chosenBranch} onChange={(v) => update({ branch: v })} options={branches.map((b) => ({ value: b, label: b, description: b === check.defaultBranch ? 'Default' : undefined }))} />
                </Field>
              ) : null}
              <Field label="New branch for the work (optional)" hint="Created from the starting branch after the download. Nothing is pushed until you push.">
                <TextInput value={draft.featureBranch} placeholder="feature/my-change" autoComplete="off" onChange={(e) => update({ featureBranch: e.target.value })} />
              </Field>
              {blockers.map((b) => <div key={b} className="ms-notice" data-tone="error" role="alert"><span className="ms-notice__text">{b}</span></div>)}
              <ul className="ms-newform__warnings">{check.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              {check.needsConfirmation ? <Checkbox checked={confirmed} onChange={setConfirmed} label="I have read the warnings and want to download this repository." /> : null}
            </>
          ) : null}
        </>
      ) : null}

      {work ? (
        <div className="ms-notice" data-tone={work.status === 'ready' ? undefined : work.status === 'cloning' ? 'attention' : 'error'} role="status">
          <span className="ms-notice__text">
            {work.status === 'cloning' ? 'Downloading the repository. You can cancel.' : work.status === 'ready' ? 'Ready. Starting Claude Code.' : work.error ?? 'The download did not finish.'}
          </span>
        </div>
      ) : null}
      {error ? <div className="ms-notice" data-tone="error" role="alert"><span className="ms-notice__text">{error}</span></div> : null}

      <div className="ms-newform__foot">
        {work?.status === 'cloning' ? <Button onClick={() => { void cancel(); }}>Cancel download</Button> : null}
        {work && (work.status === 'clone_failed' || work.status === 'cancelled') ? <Button onClick={() => { void retry(); }}>Try again</Button> : null}
        <Button variant="primary" icon="terminal" loading={busy || starting || work?.status === 'cloning'} disabled={!canBegin} onClick={() => { void begin(); }}>
          {reuse === 'new' ? 'Download and start Claude' : 'Start Claude in this checkout'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Existing local session

function ExistingForm({ project, draft, update, starting, onStartLocal, onClose }: FormProps) {
  const roots = project.roots.slice().sort((a, b) => a.position - b.position);
  const preferred = roots.find((r) => r.env === project.defaultEnv) ?? roots[0];
  const chosen = draft.rootId && roots.some((r) => r.id === draft.rootId) ? draft.rootId : preferred?.id ?? null;
  const go = async () => { if (!chosen) return; const s = await onStartLocal({ rootId: chosen, name: draft.title.trim() }); if (s) onClose(); };
  return (
    <div className="ms-newform">
      <Field label="Folder">
        <Select value={chosen} onChange={(v) => update({ rootId: v })} options={roots.map((r) => ({ value: r.id, label: r.path, description: envLabel(r.env) }))} />
      </Field>
      <Field label="Name (optional)">
        <TextInput value={draft.title} maxLength={120} autoComplete="off" onChange={(e) => update({ title: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void go(); } }} />
      </Field>
      <div className="ms-newform__foot">
        <Button variant="primary" icon="terminal" loading={starting} disabled={!chosen} onClick={() => { void go(); }}>Start session</Button>
      </div>
    </div>
  );
}
