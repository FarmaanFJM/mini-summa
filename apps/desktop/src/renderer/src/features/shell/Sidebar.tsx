import logoUrl from '../../assets/mini-summa-logo.png?inline';
import type { RefCallback } from 'react';
import { useApp, useRoute, useUi } from '../../app/runtime';
import type { ViewId } from '../../app/route';
import { Button, Icon, IconButton, Kbd } from '../../ui';
import type { IconName } from '../../ui';
import { useLayout } from './LayoutContext';
import { ProjectList } from './ProjectList';
import { QUICK_SWITCHER_HINT, useQuickSwitcher } from './QuickSwitcher';

interface SidebarProps {
  /** True while a view has replaced the sidebar content (principle 14). */
  replaced: boolean;
  slotRef: RefCallback<HTMLDivElement>;
}

/**
 * Whether the sidebar is on screen. A person may collapse it to give the workspace the room, but a view that has taken it over
 * (Settings, Reports) needs it: its navigation lives there, so it is shown while that view holds it and goes back to what the
 * person chose when the view lets go.
 */
export function sidebarShown(collapsed: boolean, replaced: boolean): boolean {
  return !collapsed || replaced;
}

/** Brand, New project, a search that opens the quick switcher, one flat list of projects, and Activity, Reports and Settings at the bottom. */
export function Sidebar({ replaced, slotRef }: SidebarProps) {
  const { layout, update } = useLayout();
  const shown = sidebarShown(layout.sidebarCollapsed, replaced);
  return (
    <aside className="ms-sidebar" aria-label="Mini-Summa navigation" hidden={!shown}>
      <div className="ms-sidebar__default" hidden={replaced}>
        <Expanded onCollapse={() => update({ sidebarCollapsed: true })} />
      </div>
      <div className="ms-sidebar__slot" ref={slotRef} hidden={!replaced} />
    </aside>
  );
}

/** The mark and the name, as in the reference shell: the one place the brand colour is drawn besides the main action. */
function Brand() {
  return (
    <div className="ms-brand">
      <img className="ms-brand__logo" src={logoUrl} alt="" width={26} height={26} draggable={false} />
      <span className="ms-brand__name">Mini-Summa</span>
    </div>
  );
}

function Expanded({ onCollapse }: { onCollapse: () => void }) {
  const openProjectDialog = useUi((s) => s.openProjectDialog);
  const quick = useQuickSwitcher();
  return (
    <>
      <header className="ms-sidebar__head">
        <Brand />
        <IconButton label="Collapse sidebar" icon="chevrons-left" size="sm" onClick={onCollapse} />
      </header>
      <div className="ms-sidebar__top">
        <Button className="ms-sidebar__new" icon="plus" onClick={() => openProjectDialog({ mode: 'create' })}>New project</Button>
        <button type="button" className="ms-sidebar__search" aria-label="Search projects" aria-haspopup="dialog" aria-keyshortcuts="Control+Shift+P" onClick={quick.open}>
          <Icon name="search" />
          <span className="ms-sidebar__search-text">Search</span>
          <Kbd>{QUICK_SWITCHER_HINT}</Kbd>
        </button>
      </div>
      <nav className="ms-sidebar__projects" aria-label="Projects"><ProjectList /></nav>
      <SidebarSections />
    </>
  );
}

const SECTIONS: { view: ViewId; label: string; icon: IconName }[] = [
  { view: 'activity', label: 'Activity', icon: 'activity' },
  { view: 'reports', label: 'Reports', icon: 'file-text' },
  { view: 'settings', label: 'Settings', icon: 'settings' },
];

function SidebarSections() {
  const counts = useApp((s) => s.counts);
  const route = useRoute();
  const numbers: Partial<Record<ViewId, number>> = { activity: counts.unreadActivity, reports: counts.reportsAwaitingHandoff };
  return (
    <nav className="ms-sidebar__foot" aria-label="Sections">
      {SECTIONS.map((item) => {
        const n = numbers[item.view] ?? 0;
        const facts = item.view === 'activity' ? `${n} unread` : `${n} waiting for handoff`;
        return (
          <button
            key={item.view}
            type="button"
            className="sm-nav-item"
            aria-current={route.view === item.view ? 'true' : undefined}
            aria-label={n > 0 && item.view !== 'settings' ? `${item.label}, ${facts}` : item.label}
            onClick={() => route.setView(item.view)}
          >
            <Icon name={item.icon} />
            <span className="ms-nav__label">{item.label}</span>
            {n > 0 ? <span className="ms-nav__count ms-live" title={facts}>{n}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
