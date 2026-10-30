import { githubRepoUrl } from '@minisumma/shared';
import type { LayoutOrientation, LayoutPrefs, Project } from '@minisumma/shared';
import { useEffect, useRef } from 'react';
import { useNative } from '../../app/native';
import { useApp, useRuntime, useUi } from '../../app/runtime';
import { Button, EmptyState, IconButton, Menu, SplitPane, Tooltip, toast } from '../../ui';
import { useLayout } from '../shell/LayoutContext';
import { HandoffStrip } from '../reports/HandoffStrip';
import { ChatGptPane } from './ChatGptPane';
import { ClaudePane } from './ClaudePane';
import { useElementSize, useSelectedProject } from './hooks';
import { decideOrientation, onlyPane, ORIENTATION_LABEL, toggleMaximized } from './layout';
import type { PaneName } from './layout';
import { maximizedOf, ViewSwitch, viewOf } from './ViewSwitch';

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
          : 'Create your first project. It needs only a name: add a GitHub repository, folders or ChatGPT when you want them.'}
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

  // Showing one pane alone only hides the other: it stays mounted, so its terminals keep their output and processes and its
  // native view keeps its page (it is told it has no place on screen, never closed or sent anywhere).
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
          first={<ChatGptPane project={project} visible={visible && layout.maximized !== 'claude'} />}
          second={<ClaudePane project={project} visible={visible && layout.maximized !== 'chatgpt'} />}
        />
      </div>
    </>
  );
}

interface BarProps { project: Project; layout: LayoutPrefs; onChange: (patch: Partial<LayoutPrefs>) => void }

/** One slim line: the project's name with where it lives, which panes are shown, the project's settings and the layout. */
function WorkspaceBar({ project, layout, onChange }: BarProps) {
  const openProjectDialog = useUi((s) => s.openProjectDialog);
  const choices: LayoutOrientation[] = ['auto', 'landscape', 'portrait'];
  return (
    <header className="ms-wsbar">
      <div className="ms-wsbar__identity">
        <h1 className="ms-wsbar__name" title={project.name}>{project.name}</h1>
        <ProjectPlaces project={project} />
      </div>
      <div className="ms-wsbar__tools">
        <ViewSwitch value={viewOf(layout.maximized)} onChange={(view) => onChange({ maximized: maximizedOf(view) })} />
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

/**
 * The GitHub repository and the first folder of the project, as quiet text beside its name. Each is what it looks like: pressing the
 * repository opens it on GitHub, pressing the folder shows it in the file manager. A project with neither shows nothing here (a
 * project without a folder or a repository is normal, and not something to label).
 */
function ProjectPlaces({ project }: { project: Project }) {
  const native = useNative();
  const repo = project.githubRepo;
  const folder = [...project.roots].sort((a, b) => a.position - b.position)[0] ?? null;
  const more = project.roots.length - 1;
  if (!repo && !folder) return null;

  const failed = (title: string) => (err: unknown) => toast({ title, body: err instanceof Error ? err.message : undefined, kind: 'error' });
  return (
    <div className="ms-wsbar__places">
      {repo ? (
        <Tooltip content={`Open ${repo} on GitHub`}>
          <button type="button" className="ms-wsbar__place" aria-label={`Open ${repo} on GitHub`} onClick={() => { native.shell.openExternal(githubRepoUrl(repo)).catch(failed('Could not open your browser')); }}>
            <span className="ms-truncate">{repo}</span>
          </button>
        </Tooltip>
      ) : null}
      {repo && folder ? <span className="ms-wsbar__sep" aria-hidden="true">·</span> : null}
      {folder ? (
        native.hasFolderPicker ? (
          <Tooltip content="Show the folder">
            <button type="button" className="ms-wsbar__place ms-wsbar__place--folder" aria-label={`Show the folder ${folder.path}`} onClick={() => { native.shell.showItemInFolder(folder.path).catch(failed('Could not show the folder')); }}>
              <span className="ms-truncate">{folder.path}</span>
            </button>
          </Tooltip>
        ) : (
          <span className="ms-wsbar__place ms-wsbar__place--folder ms-wsbar__place--text"><span className="ms-truncate" title={folder.path}>{folder.path}</span></span>
        )
      ) : null}
      {more > 0 ? <span className="ms-wsbar__more" title={`${more} more ${more === 1 ? 'folder' : 'folders'}`}>+{more}</span> : null}
    </div>
  );
}

/** Ctrl+Shift+Arrow shows ChatGPT alone (Left or Up) or Claude alone (Right or Down); pressing it again shows both. */
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
