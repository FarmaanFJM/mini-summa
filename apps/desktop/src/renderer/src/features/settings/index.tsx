// Settings. The sections replace the sidebar's content (with a back chevron), so there is still exactly one sidebar (P14);
// the page shows one section at a time and the route remembers which, so a link or a notification can open a section directly.
import '../reports/shared.css';
import './settings.css';
import { useState } from 'react';
import type { ComponentType } from 'react';
import { useRoute } from '../../app/runtime';
import { SidebarContent } from '../shell/SidebarSlot';
import { AboutSection } from './AboutSection';
import { ChatGptSection } from './ChatGptSection';
import { ClaudeCodeSection } from './ClaudeCodeSection';
import { StatusSlotContext } from './controls';
import { DataSection } from './DataSection';
import { ExtensionSection } from './ExtensionSection';
import { HooksSection } from './HooksSection';
import { resolveSection, SECTIONS } from './model';
import type { SectionId } from './model';
import { NotificationsSection } from './NotificationsSection';
import { PhoneSection } from './PhoneSection';
import { PushSection } from './PushSection';
import { RemoteAccessSection } from './RemoteAccessSection';
import { ReviewSection } from './ReviewSection';

const BODY: Record<SectionId, ComponentType> = {
  chatgpt: ChatGptSection,
  extension: ExtensionSection,
  'claude-code': ClaudeCodeSection,
  hooks: HooksSection,
  notifications: NotificationsSection,
  phones: PhoneSection,
  remote: RemoteAccessSection,
  push: PushSection,
  review: ReviewSection,
  data: DataSection,
  about: AboutSection,
};

export default function SettingsView() {
  const route = useRoute();
  const current = resolveSection(route.section);
  const Body = BODY[current];
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  const label = SECTIONS.find((s) => s.id === current)?.label ?? 'Settings';

  return (
    <section className="ms-view ms-set-view" aria-label="Settings">
      <SidebarContent title="Settings" onBack={() => route.back()}>
        <nav aria-label="Settings sections">
          <ul className="ms-sidebar__sections">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button type="button" className="sm-nav-item" aria-current={s.id === current ? 'true' : undefined} onClick={() => route.go({ section: s.id })}>{s.label}</button>
              </li>
            ))}
          </ul>
        </nav>
      </SidebarContent>
      <header className="ms-view__head">
        <h1 className="ms-view__title">{label}</h1>
        <div className="ms-x-head-actions ms-set-head-status" ref={setStatusSlot} />
      </header>
      <StatusSlotContext.Provider value={statusSlot}>
        <div className="ms-view__body" key={current}>
          <Body />
        </div>
      </StatusSlotContext.Provider>
    </section>
  );
}
