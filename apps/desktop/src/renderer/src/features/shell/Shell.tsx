import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useRoute } from '../../app/runtime';
import ActivityView from '../activity';
import { ProjectDialog } from '../projects/ProjectDialog';
import ReportsView from '../reports';
import SettingsView from '../settings';
import { useSelectedProject } from '../workspace/hooks';
import { Workspace } from '../workspace/Workspace';
import { ConnectionBanner } from './ConnectionBanner';
import { LayoutProvider, useLayout } from './LayoutContext';
import { Sidebar } from './Sidebar';
import { SidebarResizer } from './SidebarResizer';
import { SidebarSlotContext } from './SidebarSlot';

const RAIL_WIDTH = 52;

export function Shell() {
  return (
    <LayoutProvider>
      <ShellFrame />
    </LayoutProvider>
  );
}

function ShellFrame() {
  const { layout, update } = useLayout();
  const view = useRoute().view;
  const connection = useApp((s) => s.connection);
  const project = useSelectedProject();

  // A view that replaces the sidebar claims the slot; while any claim is held the project list is hidden.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => { setClaims((n) => n + 1); return () => setClaims((n) => n - 1); }, []);
  const slotValue = useMemo(() => ({ slot, claim }), [slot, claim]);

  useEffect(() => {
    document.title = view === 'workspace' && project ? `${project.name} - Mini-Summa` : 'Mini-Summa';
  }, [view, project]);

  const collapsed = layout.sidebarCollapsed;
  const width = collapsed ? RAIL_WIDTH : layout.sidebarWidth;
  return (
    <SidebarSlotContext.Provider value={slotValue}>
      <div className="ms-app" data-connection={connection}>
        <ConnectionBanner />
        <div className="ms-shell" style={{ ['--ms-sidebar-w' as string]: `${width}px` }}>
          <div className="ms-shell__side">
            <Sidebar replaced={claims > 0} slotRef={setSlot} />
            {collapsed ? null : <SidebarResizer width={layout.sidebarWidth} onChange={(w) => update({ sidebarWidth: w })} />}
          </div>
          <main className="ms-main">
            <Workspace visible={view === 'workspace'} />
            {view === 'activity' ? <ActivityView /> : null}
            {view === 'reports' ? <ReportsView /> : null}
            {view === 'settings' ? <SettingsView /> : null}
          </main>
        </div>
      </div>
      <ProjectDialog />
    </SidebarSlotContext.Provider>
  );
}
