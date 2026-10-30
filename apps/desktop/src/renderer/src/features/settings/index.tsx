// Extension point: the second UI worker replaces this placeholder with the settings sections. It shows how a view takes
// over the sidebar (principle 14): <SidebarContent> swaps the project list for its own content and gives a back chevron.
import { useRoute } from '../../app/runtime';
import { EmptyState } from '../../ui';
import { SidebarContent } from '../shell/SidebarSlot';

const SECTIONS = ['ChatGPT', 'Sessions', 'Notifications', 'Phone', 'Data'];

export default function SettingsView() {
  const route = useRoute();
  return (
    <section className="ms-view" aria-label="Settings">
      <SidebarContent title="Settings" onBack={() => route.back()}>
        <ul className="ms-sidebar__sections">
          {SECTIONS.map((name) => (
            <li key={name}>
              <button type="button" className="sm-nav-item" aria-current={route.section === name ? 'true' : undefined} onClick={() => route.go({ section: name })}>{name}</button>
            </li>
          ))}
        </ul>
      </SidebarContent>
      <header className="ms-view__head"><h1 className="ms-view__title">{route.section ?? 'Settings'}</h1></header>
      <div className="ms-view__body">
        <EmptyState>Settings are not built yet.</EmptyState>
      </div>
    </section>
  );
}
