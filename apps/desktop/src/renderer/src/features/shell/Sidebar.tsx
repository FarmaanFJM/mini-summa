import { useMemo } from 'react';
import type { RefCallback } from 'react';
import { activeProjects, resolveProject } from '../../app/selectors';
import { useApp, useRoute, useUi } from '../../app/runtime';
import type { ViewId } from '../../app/route';
import { Icon, IconButton, Menu } from '../../ui';
import type { IconName } from '../../ui';
import { useLayout } from './LayoutContext';
import { ProjectList } from './ProjectList';

interface SidebarProps {
  /** True while a view has replaced the sidebar content (principle 14). */
  replaced: boolean;
  slotRef: RefCallback<HTMLDivElement>;
}

/** Projects on top, Activity, Reports and Settings at the bottom. One level, no tree, no second sidebar. */
export function Sidebar({ replaced, slotRef }: SidebarProps) {
  const { layout, update } = useLayout();
  const collapsed = layout.sidebarCollapsed;
  return (
    <aside className="ms-sidebar" aria-label="Mini-Summa navigation" data-collapsed={collapsed || undefined}>
      <div className="ms-sidebar__default" hidden={replaced}>
        {collapsed ? <Rail onExpand={() => update({ sidebarCollapsed: false })} /> : <Expanded onCollapse={() => update({ sidebarCollapsed: true })} />}
      </div>
      <div className="ms-sidebar__slot" ref={slotRef} hidden={!replaced} />
    </aside>
  );
}

function Expanded({ onCollapse }: { onCollapse: () => void }) {
  const openProjectDialog = useUi((s) => s.openProjectDialog);
  return (
    <>
      <header className="ms-sidebar__head">
        <span className="ms-brand"><span className="ms-brand__mark" aria-hidden="true" />Mini-Summa</span>
        <IconButton label="Collapse sidebar" icon="panel" size="sm" onClick={onCollapse} />
      </header>
      <nav className="ms-sidebar__section" aria-label="Projects">
        <div className="ms-sidebar__label">
          <span>Projects</span>
          <IconButton label="New project" icon="plus" size="sm" onClick={() => openProjectDialog({ mode: 'create' })} />
        </div>
        <div className="ms-sidebar__scroll"><ProjectList /></div>
      </nav>
      <SidebarFooter />
    </>
  );
}

function useFooterData() {
  const counts = useApp((s) => s.counts);
  const route = useRoute();
  return { counts, view: route.view, go: (view: ViewId) => route.setView(view) };
}

const FOOTER: { view: ViewId; label: string; icon: IconName }[] = [
  { view: 'activity', label: 'Activity', icon: 'activity' },
  { view: 'reports', label: 'Reports', icon: 'file-text' },
  { view: 'settings', label: 'Settings', icon: 'settings' },
];

function SidebarFooter() {
  const { counts, view, go } = useFooterData();
  const numbers: Partial<Record<ViewId, number>> = { activity: counts.unreadActivity, reports: counts.reportsAwaitingHandoff };
  return (
    <nav className="ms-sidebar__foot" aria-label="Sections">
      {FOOTER.map((item) => {
        const n = numbers[item.view] ?? 0;
        const label = item.view === 'activity' ? `${n} unread` : `${n} waiting for handoff`;
        return (
          <button
            key={item.view}
            type="button"
            className="sm-nav-item"
            aria-current={view === item.view ? 'true' : undefined}
            aria-label={n > 0 && item.view !== 'settings' ? `${item.label}, ${label}` : item.label}
            onClick={() => go(item.view)}
          >
            <Icon name={item.icon} />
            <span className="ms-nav__label">{item.label}</span>
            {n > 0 ? <span className="ms-nav__count ms-live" title={label}>{n}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}

/** The collapsed sidebar: icons only. Choosing a project moves to a menu, so nothing is lost. */
function Rail({ onExpand }: { onExpand: () => void }) {
  const projects = useApp((s) => s.projects);
  const counts = useApp((s) => s.counts);
  const route = useRoute();
  const active = useMemo(() => activeProjects(projects), [projects]);
  const current = resolveProject(projects, route.projectId);
  return (
    <div className="ms-rail">
      <IconButton label="Expand sidebar" icon="panel" size="sm" onClick={onExpand} />
      <Menu
        label="Projects"
        placement="right-start"
        trigger={(props) => (
          <IconButton ref={props.ref as RefCallback<HTMLButtonElement>} label={current ? `Project: ${current.name}` : 'Projects'} icon="folder" size="sm" onClick={props.onClick} onKeyDown={props.onKeyDown} aria-haspopup="menu" aria-expanded={props['aria-expanded']} />
        )}
        items={active.map((p) => ({ label: p.name, checked: p.id === current?.id, onSelect: () => route.selectProject(p.id) }))}
      />
      <div className="ms-rail__foot">
        {FOOTER.map((item) => {
          const n = item.view === 'activity' ? counts.unreadActivity : item.view === 'reports' ? counts.reportsAwaitingHandoff : 0;
          return (
            <span key={item.view} className="ms-rail__item">
              <IconButton label={n > 0 ? `${item.label}, ${n}` : item.label} icon={item.icon} size="sm" pressed={route.view === item.view} onClick={() => route.setView(item.view)} />
              {n > 0 ? <span className="ms-rail__count ms-live" aria-hidden="true">{n > 99 ? '99+' : n}</span> : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}
