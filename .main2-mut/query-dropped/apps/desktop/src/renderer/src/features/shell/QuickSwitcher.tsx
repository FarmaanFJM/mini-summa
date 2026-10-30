// The quick switcher: one keystroke from anywhere to any project. A dialog with a filter field and the list of projects; the
// arrow keys move, Enter switches, Esc closes. It shows which projects have a session that needs the person.
//
// Opened by the search entry of the sidebar and by Ctrl+Shift+P. The chord is Ctrl+Shift+P rather than Ctrl+K or any other plain
// Ctrl+letter because Claude's terminal needs those; it is registered on the window in the capture phase, like the Ctrl+Shift+Arrow
// handler of the workspace, so it works wherever the keyboard focus is inside the window (including the terminal).
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { Project } from '@minisumma/shared';
import { activeProjects, resolveProject, statsByProject } from '../../app/selectors';
import type { ProjectStats } from '../../app/selectors';
import { useApp, useRoute } from '../../app/runtime';
import { Dialog, Icon } from '../../ui';
import { projectLabel } from './ProjectList';

export const QUICK_SWITCHER_HINT = 'Ctrl+Shift+P';

interface QuickSwitcherApi {
  open(): void;
  isOpen: boolean;
}

const NONE: QuickSwitcherApi = { open() {}, isOpen: false };
const QuickSwitcherContext = createContext<QuickSwitcherApi>(NONE);

/** The way to open the switcher from the sidebar. Outside a provider it does nothing, so a part of the shell can be rendered alone. */
export function useQuickSwitcher(): QuickSwitcherApi {
  return useContext(QuickSwitcherContext);
}

/** Ctrl+Shift+P, and nothing else (no Alt, no Meta). */
export function isQuickSwitcherChord(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): boolean {
  return e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'KeyP' || e.key === 'P' || e.key === 'p');
}

/** What a project is called for filtering: its name, its repository and the folders it works in. */
export function projectHaystack(project: Project): string {
  return [project.name, project.githubRepo ?? '', ...project.roots.map((r) => r.path)].join('\n').toLowerCase();
}

/** The projects that match what was typed: every word has to appear in the name, the repository or a folder. Order is the sidebar's. */
export function filterProjects(projects: readonly Project[], query: string): Project[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...projects];
  return projects.filter((p) => { const hay = projectHaystack(p); return words.every((w) => hay.includes(w)); });
}

export function QuickSwitcherProvider({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isQuickSwitcherChord(e)) return;
      // Another dialog (a project form, a confirmation) is a decision in progress: do not stack a second layer over it.
      if (!openRef.current && document.querySelector('[data-ms-layer="dialog"]')) return;
      e.preventDefault();
      e.stopPropagation(); // before the terminal sees it
      setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const api = useMemo<QuickSwitcherApi>(() => ({ open: () => setOpen(true), isOpen: open }), [open]);
  const close = useCallback(() => setOpen(false), []);
  return (
    <QuickSwitcherContext.Provider value={api}>
      {children}
      <QuickSwitcher open={open} onClose={close} />
    </QuickSwitcherContext.Provider>
  );
}

const EMPTY_STATS: ProjectStats = { liveSessions: 0, needsAttention: false, waitingReports: 0 };

export function QuickSwitcher({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projects = useApp((s) => s.projects);
  const sessions = useApp((s) => s.sessions);
  const reports = useApp((s) => s.reports);
  const route = useRoute();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const all = useMemo(() => activeProjects(projects), [projects]);
  const stats = useMemo(() => statsByProject(all, sessions, reports), [all, sessions, reports]);
  const shown = useMemo(() => filterProjects(all, query), [all, query]);
  const currentId = resolveProject(projects, route.projectId)?.id ?? null;

  // Each opening starts clean, on the project the person is in, so Enter alone is "stay here" and one arrow is "the next one".
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(Math.max(0, all.findIndex((p) => p.id === currentId)));
    // Only when it opens: the list changing under the person (a session ending) must not move their selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const at = Math.min(cursor, Math.max(0, shown.length - 1));
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, at, shown]);

  const choose = (project: Project) => {
    onClose();
    route.selectProject(project.id);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (shown.length) setCursor((at + 1) % shown.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown.length) setCursor((at - 1 + shown.length) % shown.length); }
    else if (e.key === 'Enter') { e.preventDefault(); const p = shown[at]; if (p) choose(p); }
  };

  const optionId = (p: Project) => `${listId}-${p.id}`;
  return (
    <Dialog open={open} onClose={onClose} title="Switch project" hideTitle placement="top" size="md" className="ms-quick">
      <div className="ms-quick__field">
        <Icon name="search" />
        <input
          className="sm-input ms-quick__input"
          type="text"
          role="combobox"
          aria-label="Search projects"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown[at] ? optionId(shown[at]) : undefined}
          placeholder="Switch to a project"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
          onKeyDown={onKeyDown}
        />
      </div>
      {shown.length === 0 ? (
        <p className="ms-quick__empty" role="status">{all.length === 0 ? 'There are no projects yet.' : 'No project matches.'}</p>
      ) : (
        <ul id={listId} ref={list} className="ms-quick__list" role="listbox" aria-label="Projects">
          {shown.map((p, i) => {
            const s = stats.get(p.id) ?? EMPTY_STATS;
            return (
              <li
                key={p.id}
                id={optionId(p)}
                role="option"
                aria-selected={i === at}
                aria-label={projectLabel(p.name, s)}
                className="ms-quick__option"
                data-current={p.id === currentId || undefined}
                onMouseMove={() => { if (i !== at) setCursor(i); }}
                onClick={() => choose(p)}
              >
                <span className="ms-quick__name">{p.name}</span>
                {p.githubRepo ? <span className="ms-quick__meta">{p.githubRepo}</span> : null}
                {s.needsAttention ? <span className="ms-dot ms-dot--attention" role="img" aria-label="Needs your attention" /> : null}
                {p.id === currentId ? <Icon name="check" className="sm-menu__check" /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
