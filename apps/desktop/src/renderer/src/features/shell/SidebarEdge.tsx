// What is left of the sidebar when it is collapsed: a quiet tab on the window's left edge that opens it again
// (Summa-UI docs/WORKSPACE_PATTERN.md, 7a: a panel is shown and hidden by an edge chevron). There is no icon rail: a rail would need
// an icon for every project, and a folder icon repeated per project says nothing. Projects are one keystroke away in the
// quick switcher, and the tab carries the one fact worth seeing from outside: that a session is waiting for the person.
import { useApp } from '../../app/runtime';
import { needsAttention } from '../../app/selectors';
import { Icon } from '../../ui';

/** Width of the strip of page the tab sits in. Nothing is drawn under it, so it never covers the workspace or the native view. */
export const SIDEBAR_EDGE_WIDTH = 18;

export function SidebarEdge({ onExpand }: { onExpand: () => void }) {
  const attention = useApp((s) => s.sessions.some(needsAttention));
  return (
    <div className="ms-edge">
      <button
        type="button"
        className="ms-edge__tab"
        aria-label="Expand sidebar"
        aria-expanded="false"
        aria-description={attention ? 'A session needs your attention' : undefined}
        title="Expand sidebar"
        onClick={onExpand}
      >
        <Icon name="chevron-right" size={14} />
        {attention ? <span className="ms-dot ms-dot--attention ms-edge__dot" aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
