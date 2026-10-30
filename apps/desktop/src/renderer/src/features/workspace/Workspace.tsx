import { envLabel } from '@minisumma/shared';
import type { LayoutOrientation, LayoutPrefs, Project } from '@minisumma/shared';
import { useEffect, useRef } from 'react';
import { useApp, useRuntime, useUi } from '../../app/runtime';
import { Button, EmptyState, IconButton, Menu, SplitPane } from '../../ui';
import { useLayout } from '../shell/LayoutContext';
import { HandoffStrip } from '../reports/HandoffStrip';
import { ChatGptPane } from './ChatGptPane';
import { ClaudePane } from './ClaudePane';
import { useElementSize, useSelectedProject } from './hooks';
import { decideOrientation, onlyPane, ORIENTATION_LABEL, toggleMaximized } from './layout';
import type { PaneName } from './layout';

/** The core screen: ChatGPT and Claude side by side (or stacked) for one project. Stays mounted while other views show. */
export function Workspace({ visible }: { visible: boolean }) {
  const loaded = useApp((s) => s.loaded);
  const project = useSelectedProject();
  return (
    <div className="ms-workspace" hidden={!visible}>
      {!loaded ? <WorkspaceWaiting /> : project ? <WorkspaceBody project={project} visible={visible} /> : <NoProjects />}
    </div>
  );
}

/** Before the first snapshot: loading, offline or failed, each said plainly. The shell around it stays visible. */
function WorkspaceWaiting() {
  const connection = useApp((s) => s.connection);
  const loadError = useApp((s) => s.loadError);
  const { loader } = useRuntime();
  if (loadError) {
    return (
      <div className="ms-workspace__state">
        <EmptyState center tone="error" action={<Button onClick={() => { void loader.reload(); }}>Try again</Button>}>
          Mini-Summa could not load its data. {loadError}
        </EmptyState>
      </div>
    );
  }
  if (connection === 'reconnecting' || connection === 'closed') {
    return (
      <div className="ms-workspace__state">
        <EmptyState center>Mini-Summa is not reachable. Reconnecting.</EmptyState>
      </div>
    );
  }
  return (
    <div className="ms-workspace__state" aria-busy="true" role="status" aria-label="Loading">
      <div className="ms-skeleton-list ms-skeleton-list--wide">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="ms-skeleton-row" />)}</div>
    </div>
  );
}

function NoProjects() {
  const openProjectDialog = useUi((s) => s.openProjectDialog);
  const archived = useApp((s) => s.projects.some((p) => p.archivedAt !== null));
  return (
    <div className="ms-workspace__state">
      <EmptyState center action={<Button variant="primary" icon="plus" onClick={() => openProjectDialog({ mode: 'create' })}>Create project</Button>}>
        {archived
          ? 'Every project is archived. Restore one from Archived in the sidebar, or create a new one.'
          : 'Create your first project. A project connects a folder, the ChatGPT conversations you use for it, and its Claude sessions.'}
      </EmptyState>
    </div>
  );
}

function WorkspaceBody({ project, visible }: { project: Project; visible: boolean }) {
  const { layout, update } = useLayout();
  const area = useRef<HTMLDivElement>(null);
  const size = useElementSize(area);
  const orientation = decideOrientation(layout.orientation, size);
  const horizontal = orientation === 'landscape';
  const ratio = horizontal ? layout.landscapeRatio : layout.portraitRatio;
  const toggle = (pane: PaneName) => update({ maximized: toggleMaximized(layout.maximized, pane) });

  useMaximizeShortcuts(visible, layout.maximized, toggle);

  return (
    <>
      <WorkspaceBar project={project} layout={layout} onChange={update} />
      <HandoffStrip project={project} />
      <div className="ms-workspace__area" ref={area} data-orientation={orientation}>
        <SplitPane
          direction={horizontal ? 'horizontal' : 'vertical'}
          ratio={ratio}
          onRatioChange={(r) => update(horizontal ? { landscapeRatio: r } : { portraitRatio: r })}
          only={onlyPane(layout.maximized)}
          label="Resize the ChatGPT and Claude panes"
          names={['ChatGPT', 'Claude']}
          first={<ChatGptPane project={project} visible={visible && layout.maximized !== 'claude'} maximized={layout.maximized === 'chatgpt'} onToggleMaximize={() => toggle('chatgpt')} />}
          second={<ClaudePane project={project} visible={visible && layout.maximized !== 'chatgpt'} maximized={layout.maximized === 'claude'} onToggleMaximize={() => toggle('claude')} />}
        />
      </div>
    </>
  );
}

function projectSubtitle(project: Project): string {
  const first = project.roots[0];
  const folders = first
    ? `${first.path}${project.roots.length > 1 ? ` and ${project.roots.length - 1} more ${project.roots.length === 2 ? 'folder' : 'folders'}` : ''}`
    : 'No folder yet';
  return [project.githubRepo, folders].filter(Boolean).join(' · ');
}

interface BarProps { project: Project; layout: LayoutPrefs; onChange: (patch: Partial<LayoutPrefs>) => void }

function WorkspaceBar({ project, layout, onChange }: BarProps) {
  const openProjectDialog = useUi((s) => s.openProjectDialog);
  const choices: LayoutOrientation[] = ['auto', 'landscape', 'portrait'];
  const subtitle = projectSubtitle(project);
  const envs = [...new Set(project.roots.map((r) => r.env))];
  return (
    <header className="ms-wsbar">
      <div className="ms-wsbar__identity">
        <h1 className="ms-wsbar__name">{project.name}</h1>
        <span className="ms-wsbar__meta ms-truncate" title={subtitle}>{subtitle}{envs.length === 1 && project.roots.length > 0 ? ` · ${envLabel(envs[0])}` : ''}</span>
      </div>
      <div className="ms-wsbar__tools">
        {layout.maximized ? <Button size="sm" variant="ghost" icon="minimize" onClick={() => onChange({ maximized: null })}>Show both panes</Button> : null}
        <IconButton label={`Edit ${project.name}`} icon="pencil" size="sm" onClick={() => openProjectDialog({ mode: 'edit', projectId: project.id })} />
        <Menu
          label="Layout"
          placement="bottom-end"
          trigger={(props) => (
            <IconButton ref={props.ref as (el: HTMLButtonElement | null) => void} label={`Layout: ${ORIENTATION_LABEL[layout.orientation]}`} icon="layout" size="sm" aria-haspopup="menu" aria-expanded={props['aria-expanded']} onClick={props.onClick} onKeyDown={props.onKeyDown} />
          )}
          items={[
            { type: 'heading', label: 'Layout' },
            ...choices.map((c) => ({ label: ORIENTATION_LABEL[c], checked: layout.orientation === c, radio: true, icon: c === 'portrait' ? 'rows' as const : c === 'landscape' ? 'columns' as const : 'layout' as const, onSelect: () => onChange({ orientation: c }) })),
          ]}
        />
      </div>
    </header>
  );
}

/** Ctrl+Shift+Arrow maximises ChatGPT (Left or Up) or Claude (Right or Down); pressing it again restores both. */
function useMaximizeShortcuts(enabled: boolean, maximized: PaneName | null, toggle: (pane: PaneName) => void) {
  const latest = useRef({ maximized, toggle });
  latest.current = { maximized, toggle };
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
      const pane: PaneName | null = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? 'chatgpt' : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 'claude' : null;
      if (!pane) return;
      e.preventDefault();
      e.stopPropagation(); // before the terminal sees it
      latest.current.toggle(pane);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}
