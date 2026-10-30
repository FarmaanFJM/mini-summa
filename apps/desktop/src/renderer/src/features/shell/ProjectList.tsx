import type { Project } from '@minisumma/shared';
import { useEffect, useMemo, useState } from 'react';
import { activeProjects, archivedProjects, resolveProject, statsByProject } from '../../app/selectors';
import type { ProjectStats } from '../../app/selectors';
import { useApi, useApp, useRoute, useUi } from '../../app/runtime';
import { ConfirmDialog, Icon, IconButton, Menu, toast } from '../../ui';
import { pluralize } from '../text';

const plural = pluralize;

/** The sentence a screen reader gets for a project row: the name, then only the facts that are true. */
export function projectLabel(name: string, stats: ProjectStats): string {
  const facts = [
    stats.liveSessions > 0 ? plural(stats.liveSessions, 'live session') : null,
    stats.needsAttention ? 'needs your attention' : null,
    stats.waitingReports > 0 ? `${plural(stats.waitingReports, 'report')} waiting for handoff` : null,
  ].filter(Boolean);
  return facts.length ? `${name}, ${facts.join(', ')}` : name;
}

type Confirm = { kind: 'archive' | 'delete'; project: Project } | null;

export function ProjectList() {
  const projects = useApp((s) => s.projects);
  const sessions = useApp((s) => s.sessions);
  const reports = useApp((s) => s.reports);
  const loaded = useApp((s) => s.loaded);
  const route = useRoute();
  const openProjectDialog = useUi((s) => s.openProjectDialog);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const active = useMemo(() => activeProjects(projects), [projects]);
  const stats = useMemo(() => statsByProject(active, sessions, reports), [active, sessions, reports]);
  const selectedId = resolveProject(projects, route.projectId)?.id ?? null;

  if (!loaded) {
    return (
      <div className="ms-skeleton-list" aria-busy="true" aria-label="Loading projects">
        {[0, 1, 2, 3].map((i) => <div key={i} className="ms-skeleton-row" />)}
      </div>
    );
  }

  return (
    <>
      {active.length === 0 ? (
        <p className="ms-sidebar__empty">No projects yet.</p>
      ) : (
        <ul className="ms-projects">
          {active.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              stats={stats.get(p.id)}
              selected={p.id === selectedId}
              onSelect={() => route.selectProject(p.id)}
              onEdit={() => openProjectDialog({ mode: 'edit', projectId: p.id })}
              onArchive={() => setConfirm({ kind: 'archive', project: p })}
              onDelete={() => setConfirm({ kind: 'delete', project: p })}
            />
          ))}
        </ul>
      )}
      <ArchivedProjects />
      <ProjectConfirm confirm={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

interface RowProps {
  project: Project;
  stats: ProjectStats | undefined;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

function ProjectRow({ project, stats, selected, onSelect, onEdit, onArchive, onDelete }: RowProps) {
  const [menu, setMenu] = useState<{ open: boolean; point: { x: number; y: number } | null }>({ open: false, point: null });
  const s = stats ?? { liveSessions: 0, needsAttention: false, waitingReports: 0 };
  return (
    <li className="ms-project" data-selected={selected || undefined} data-menu-open={menu.open || undefined}>
      <button
        type="button"
        className="ms-project__main"
        aria-current={selected ? 'true' : undefined}
        aria-label={projectLabel(project.name, s)}
        onClick={onSelect}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ open: true, point: { x: e.clientX, y: e.clientY } }); }}
      >
        <span className="ms-project__name">{project.name}</span>
        <span className="ms-project__meta ms-live">
          {s.needsAttention ? <span className="ms-dot ms-dot--attention" role="img" aria-label="Needs your attention" title="A session needs your attention" /> : null}
          {s.liveSessions > 0 ? (
            <span className="ms-meta" title={plural(s.liveSessions, 'live session')}><Icon name="terminal" size={14} />{s.liveSessions}</span>
          ) : null}
          {s.waitingReports > 0 ? (
            <span className="ms-meta" title={`${plural(s.waitingReports, 'report')} waiting for handoff`}><Icon name="file-text" size={14} />{s.waitingReports}</span>
          ) : null}
        </span>
      </button>
      <Menu
        label={`Actions for ${project.name}`}
        open={menu.open}
        anchorPoint={menu.point}
        placement="bottom-end"
        onOpenChange={(open) => setMenu((m) => ({ open, point: open ? m.point : null }))}
        trigger={(props) => (
          <IconButton
            ref={props.ref as (el: HTMLButtonElement | null) => void}
            label={`Actions for ${project.name}`}
            icon="more-h"
            size="sm"
            tooltip={false}
            className="ms-project__more"
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onKeyDown={props.onKeyDown}
            onClick={() => setMenu((m) => ({ open: !m.open, point: null }))}
          />
        )}
        items={[
          { label: 'Edit project', icon: 'pencil', onSelect: onEdit },
          { label: 'Archive project', icon: 'archive', onSelect: onArchive },
          { type: 'separator' },
          { label: 'Delete project', icon: 'trash', danger: true, onSelect: onDelete },
        ]}
      />
    </li>
  );
}

function ProjectConfirm({ confirm, onClose }: { confirm: Confirm; onClose: () => void }) {
  const api = useApi();
  const reportCount = useApp((s) => (confirm ? s.reports.filter((r) => r.projectId === confirm.project.id).length : 0));
  const deliveryCount = useApp((s) => (confirm ? s.deliveries.filter((d) => d.projectId === confirm.project.id).length : 0));
  const liveCount = useApp((s) => (confirm ? s.sessions.filter((x) => x.projectId === confirm.project.id && x.availability === 'live').length : 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [confirm]);

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      await api.call('projects.remove', { params: { id: confirm.project.id }, query: { mode: confirm.kind } });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!confirm) return null;
  const { project } = confirm;
  const sessionsNote = liveCount > 0 ? ` ${liveCount === 1 ? 'The running session is' : `The ${liveCount} running sessions are`} not stopped.` : '';
  return confirm.kind === 'archive' ? (
    <ConfirmDialog
      open
      title={`Archive ${project.name}?`}
      description={`It leaves the sidebar. Its ${plural(reportCount, 'report')}, ${plural(deliveryCount, 'delivery', 'deliveries')} and history are kept, and you can restore it from Archived.${sessionsNote}`}
      confirmLabel="Archive project"
      busy={busy}
      error={error}
      onConfirm={run}
      onCancel={onClose}
    />
  ) : (
    <ConfirmDialog
      open
      destructive
      title={`Delete ${project.name}?`}
      description={`This removes the project, its ${plural(reportCount, 'report')}, ${plural(deliveryCount, 'delivery', 'deliveries')} and its history from Mini-Summa. It cannot be undone. Your files and ChatGPT conversations are not touched.${sessionsNote}`}
      confirmLabel="Delete project"
      busy={busy}
      error={error}
      onConfirm={run}
      onCancel={onClose}
    />
  );
}

/** Archived projects, out of the way until there are some. Restore brings one back with everything it kept. */
function ArchivedProjects() {
  const api = useApi();
  const live = useApp((s) => s.connection === 'live');
  const inStore = useApp((s) => s.projects);
  const [fetched, setFetched] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    api.call('projects.list', { query: { includeArchived: true } }).then((all) => { if (!cancelled) setFetched(all.filter((p) => p.archivedAt !== null)); }, () => {});
    return () => { cancelled = true; };
  }, [api, live]);

  const archived = useMemo(() => {
    const merged = new Map(fetched.map((p) => [p.id, p]));
    for (const p of inStore) merged.set(p.id, p);
    return archivedProjects([...merged.values()]);
  }, [fetched, inStore]);

  const [confirmDelete, setConfirmDelete] = useState<Project | null>(null);
  if (archived.length === 0) return null;

  const restore = async (p: Project) => {
    try { await api.call('projects.update', { params: { id: p.id }, body: { archived: false } }); }
    catch (err) { toast({ title: 'Could not restore the project', body: err instanceof Error ? err.message : undefined, kind: 'error' }); }
  };

  return (
    <div className="ms-archived">
      <button type="button" className="ms-archived__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span>Archived</span>
        <span className="ms-archived__count">{archived.length}</span>
      </button>
      {open ? (
        <ul className="ms-projects">
          {archived.map((p) => (
            <li key={p.id} className="ms-project ms-project--archived">
              <span className="ms-project__main ms-project__main--static"><span className="ms-project__name">{p.name}</span></span>
              <IconButton label={`Restore ${p.name}`} icon="undo" size="sm" onClick={() => { void restore(p); }} />
              <IconButton label={`Delete ${p.name}`} icon="trash" size="sm" onClick={() => setConfirmDelete(p)} />
            </li>
          ))}
        </ul>
      ) : null}
      <ProjectConfirm confirm={confirmDelete ? { kind: 'delete', project: confirmDelete } : null} onClose={() => setConfirmDelete(null)} />
    </div>
  );
}
