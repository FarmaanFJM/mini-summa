import type { Project, SessionView, TempWorkspace, WorkspaceInspection } from '@minisumma/shared';
import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../app/runtime';
import { Button, Checkbox, Dialog, EmptyState, Spinner, Tag, TextInput, toast } from '../../ui';

export interface TempWorkspacesProps {
  project: Project;
  open: boolean;
  onClose: () => void;
  onStart: (o: { workspaceId: string; name: string }) => Promise<SessionView | null>;
}

const STATUS: Record<TempWorkspace['status'], string> = {
  cloning: 'Downloading', ready: 'Ready', clone_failed: 'Download failed', cancelled: 'Cancelled', removed: 'Removed',
};

/**
 * Temporary workspaces of a project: continue in one, review what is in it and whether it is published, and clean it up when that is
 * safe. Cleanup is offered only after a fresh inspection says nothing would be lost, and asks for the repository name to be typed.
 */
export function TempWorkspaces({ project, open, onClose, onStart }: TempWorkspacesProps) {
  const api = useApi();
  const [items, setItems] = useState<TempWorkspace[] | null>(null);
  const [looking, setLooking] = useState<{ id: string; view: WorkspaceInspection | null; error: string | null } | null>(null);
  const [typed, setTyped] = useState('');
  const [permanent, setPermanent] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setItems((await api.call('workspaces.list', { params: { id: project.id } })).filter((w) => w.purpose === 'session')); }
    catch (err) { toast({ title: 'Could not list workspaces', body: err instanceof Error ? err.message : undefined, kind: 'error' }); }
  }, [api, project.id]);
  useEffect(() => { if (open) void load(); }, [open, load]);

  const inspect = async (id: string) => {
    setLooking({ id, view: null, error: null }); setTyped(''); setPermanent(false);
    try { setLooking({ id, view: await api.call('workspaces.inspect', { params: { id } }), error: null }); }
    catch (err) { setLooking({ id, view: null, error: err instanceof Error ? err.message : String(err) }); }
  };
  const cleanup = async (w: TempWorkspace, view: WorkspaceInspection) => {
    setBusy(true);
    try {
      await api.call('workspaces.cleanup', { params: { id: w.id }, body: { confirmRepo: typed, permanent: view.recoverableDelete ? undefined : permanent } });
      toast({ title: view.recoverableDelete ? 'Moved to the Recycle Bin or Trash' : 'Workspace deleted', kind: 'success', durationMs: 4000 });
      setLooking(null); await load();
    } catch (err) { toast({ title: 'Not cleaned up', body: err instanceof Error ? err.message : undefined, kind: 'error' }); await inspect(w.id); }
    finally { setBusy(false); }
  };
  const act = async (call: () => Promise<unknown>, failTitle: string) => {
    try { await call(); await load(); } catch (err) { toast({ title: failTitle, body: err instanceof Error ? err.message : undefined, kind: 'error' }); }
  };

  const inspected = looking ? items?.find((w) => w.id === looking.id) ?? null : null;
  return (
    <Dialog open={open} onClose={onClose} title="Temporary workspaces" description={`Checkouts of ${project.githubRepo ?? 'the repository'} that Mini-Summa downloaded. Your own project folders are never listed here and never removed.`} size="lg">
      {items === null ? <Spinner /> : items.length === 0 ? <EmptyState>No temporary workspaces.</EmptyState> : (
        <ul className="ms-wslist">
          {items.map((w) => (
            <li key={w.id} className="ms-wslist__item">
              <div className="ms-wslist__row">
                <Tag>{STATUS[w.status]}</Tag>
                <span className="ms-wslist__name ms-truncate">{w.featureBranch ?? w.branch ?? 'checkout'}</span>
                <span className="ms-wslist__when">{new Date(w.createdAt).toLocaleString()}</span>
              </div>
              <div className="ms-mono ms-truncate ms-wslist__path" title={w.path}>{w.path}</div>
              {w.error ? <p className="ms-wslist__error">{w.error}</p> : null}
              <div className="ms-wslist__actions">
                {w.status === 'ready' ? <Button size="sm" icon="terminal" onClick={async () => { const s = await onStart({ workspaceId: w.id, name: '' }); if (s) onClose(); }}>Continue with Claude</Button> : null}
                {w.status === 'ready' || w.status === 'clone_failed' || w.status === 'cancelled' ? <Button size="sm" onClick={() => { void inspect(w.id); }}>Review and clean up</Button> : null}
                {w.status === 'clone_failed' || w.status === 'cancelled' ? <Button size="sm" onClick={() => { void act(() => api.call('workspaces.retry', { params: { id: w.id } }), 'Could not retry'); }}>Try again</Button> : null}
                {w.status === 'cloning' ? <Button size="sm" onClick={() => { void act(() => api.call('workspaces.cancel', { params: { id: w.id } }), 'Could not cancel'); }}>Cancel</Button> : null}
              </div>
              {looking?.id === w.id ? (
                <Review w={w} state={looking} typed={typed} setTyped={setTyped} permanent={permanent} setPermanent={setPermanent} busy={busy} onCleanup={(v) => { void cleanup(w, v); }} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {inspected === null && looking ? <p className="ms-newform__fine">That workspace is no longer listed.</p> : null}
    </Dialog>
  );
}

function Review({ w, state, typed, setTyped, permanent, setPermanent, busy, onCleanup }: {
  w: TempWorkspace; state: { view: WorkspaceInspection | null; error: string | null }; typed: string; setTyped: (s: string) => void;
  permanent: boolean; setPermanent: (b: boolean) => void; busy: boolean; onCleanup: (v: WorkspaceInspection) => void;
}) {
  const v = state.view;
  if (state.error) return <div className="ms-notice" data-tone="error" role="alert"><span className="ms-notice__text">{state.error}</span></div>;
  if (!v) return <p className="ms-newform__fine"><Spinner /> Checking the workspace and asking GitHub what is published</p>;
  const publication = v.publication === 'published' ? 'The branch on GitHub matches' : v.publication === 'unpublished' ? 'The branch on GitHub does not have this work' : 'Could not be checked';
  return (
    <div className="ms-review">
      <dl className="ms-facts">
        <dt>Branch</dt><dd>{v.branch ?? 'none'}</dd>
        <dt>Not committed</dt><dd>{v.trackedChanges} changed, {v.untracked} new</dd>
        <dt>Not on GitHub</dt><dd>{v.unpushedCommits === null ? 'Unknown' : `${v.unpushedCommits} commit${v.unpushedCommits === 1 ? '' : 's'}`}{v.unpublishedBranches.length ? ` (${v.unpublishedBranches.join(', ')})` : ''}</dd>
        <dt>Published</dt><dd>{publication}</dd>
      </dl>
      {v.blockers.map((b) => <div key={b} className="ms-notice" data-tone="error" role="status"><span className="ms-notice__text">{b}</span></div>)}
      {v.warnings.length > 0 ? <ul className="ms-newform__warnings">{v.warnings.map((x) => <li key={x}>{x}</li>)}</ul> : null}
      {v.safeToClean ? (
        <div className="ms-review__confirm">
          <p className="ms-newform__fine">
            {v.recoverableDelete ? 'The folder goes to the Recycle Bin or Trash, so it can be restored.' : 'This computer has no Recycle Bin or Trash that Mini-Summa can use. Deleting is permanent.'}
          </p>
          {!v.recoverableDelete ? <Checkbox checked={permanent} onChange={setPermanent} label="Delete permanently" /> : null}
          <TextInput value={typed} placeholder={`Type ${w.repo} to confirm`} autoComplete="off" aria-label={`Type ${w.repo} to confirm`} onChange={(e) => setTyped(e.target.value)} />
          <Button variant="destructive" loading={busy} disabled={typed.trim().toLowerCase() !== w.repo.toLowerCase() || (!v.recoverableDelete && !permanent)} onClick={() => onCleanup(v)}>Clean up workspace</Button>
        </div>
      ) : <p className="ms-newform__fine">Clean up is offered when nothing would be lost.</p>}
    </div>
  );
}
