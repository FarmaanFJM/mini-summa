import { useEffect } from 'react';
import { useApp, useRoute } from '../../app/runtime';
import ActivityView from '../activity';
import { ProjectDialog } from '../projects/ProjectDialog';
import ReportsView from '../reports';
import SettingsView from '../settings';
import { useSelectedProject } from '../workspace/hooks';
import { Workspace } from '../workspace/Workspace';
import { ConnectionBanner } from './ConnectionBanner';
import { LayoutProvider, useLayout } from './LayoutContext';
import { QuickSwitcherProvider } from './QuickSwitcher';
import { Sidebar, sidebarShown } from './Sidebar';
import { SidebarEdge } from './SidebarEdge';
import { SidebarResizer } from './SidebarResizer';
import { SidebarSlotContext, useSidebarSlotHost } from './SidebarSlot';

export function Shell() {
  return (
    <LayoutProvider>
      <ShellFrame />
    </LayoutProvider>
  );
}

/**
 * The page is the darkest surface. The sidebar sits on it with no border, and the content is an inset, rounded, lighter panel
 * (the Summa-UI AppShell). Collapsed, the sidebar is nothing but a quiet tab on the window's edge.
 */
function ShellFrame() {
  const { layout, update } = useLayout();
  const view = useRoute().view;
  const connection = useApp((s) => s.connection);
  const project = useSelectedProject();

  // A view that replaces the sidebar claims the slot; while any claim is held the project list is hidden.
  const sidebarSlot = useSidebarSlotHost();

  useEffect(() => {
    document.title = view === 'workspace' && project ? `${project.name} - Mini-Summa` : 'Mini-Summa';
  }, [view, project]);

  const shown = sidebarShown(layout.sidebarCollapsed, sidebarSlot.replaced);
  return (
    <SidebarSlotContext.Provider value={sidebarSlot.value}>
      <QuickSwitcherProvider>
        <div className="ms-app" data-connection={connection}>
          <ConnectionBanner />
          <div className="ms-shell" data-sidebar={shown ? 'shown' : 'collapsed'} style={{ ['--ms-sidebar-w' as string]: `${layout.sidebarWidth}px` }}>
            <div className="ms-shell__side">
              <Sidebar replaced={sidebarSlot.replaced} slotRef={sidebarSlot.setSlot} />
              {shown ? <SidebarResizer width={layout.sidebarWidth} onChange={(w) => update({ sidebarWidth: w })} /> : null}
            </div>
            {shown ? null : <SidebarEdge onExpand={() => update({ sidebarCollapsed: false })} />}
            <main className="ms-main">
              <Workspace visible={view === 'workspace'} />
              {view === 'activity' ? <ActivityView /> : null}
              {view === 'reports' ? <ReportsView /> : null}
              {view === 'settings' ? <SettingsView /> : null}
            </main>
          </div>
        </div>
        <ProjectDialog />
      </QuickSwitcherProvider>
    </SidebarSlotContext.Provider>
  );
}
