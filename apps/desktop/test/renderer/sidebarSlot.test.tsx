// A view takes over the sidebar instead of opening a second one beside it (principle 14). This is the contract the settings view
// (and any other view with its own secondary navigation) relies on, tested with a stand-in view so it does not depend on one.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { RuntimeProvider, useRoute } from '../../src/renderer/src/app/runtime';
import { LayoutProvider, useLayout } from '../../src/renderer/src/features/shell/LayoutContext';
import { Sidebar, sidebarShown } from '../../src/renderer/src/features/shell/Sidebar';
import { SidebarContent, SidebarSlotContext, useSidebarSlotHost } from '../../src/renderer/src/features/shell/SidebarSlot';
import { createHarness, until } from './helpers';

function StandInView({ name }: { name: string }) {
  const route = useRoute();
  return (
    <section aria-label={name}>
      <SidebarContent title={name} onBack={() => route.back()}>
        <ul><li><button type="button">Section one</button></li><li><button type="button">Section two</button></li></ul>
      </SidebarContent>
    </section>
  );
}

function Frame({ views }: { views: Partial<Record<'activity' | 'reports' | 'settings', string>> }) {
  const host = useSidebarSlotHost();
  const view = useRoute().view;
  return (
    <SidebarSlotContext.Provider value={host.value}>
      <Sidebar replaced={host.replaced} slotRef={host.setSlot} />
      <main>
        {view !== 'workspace' && views[view] ? <StandInView name={views[view]!} /> : null}
        {view === 'workspace' ? <h1>Workspace</h1> : null}
        {view !== 'workspace' && !views[view] ? <section aria-label={view}>No sidebar content here</section> : null}
      </main>
    </SidebarSlotContext.Provider>
  );
}

async function mount(views: Parameters<typeof Frame>[0]['views']) {
  const harness = createHarness();
  const view = render(
    <RuntimeProvider runtime={harness.runtime}><LayoutProvider><Frame views={views} /></LayoutProvider></RuntimeProvider>,
  );
  await screen.findByRole('button', { name: /^GitManager(,|$)/ });
  return { ...harness, view };
}

const projectNav = () => screen.getByRole('navigation', { name: 'Projects', hidden: true });

describe('a view that replaces the sidebar', () => {
  it('swaps the project list for its own content with a back chevron, and back restores it', async () => {
    const user = userEvent.setup();
    await mount({ settings: 'Settings' });
    expect(projectNav().closest('[hidden]')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Section one' })).toBeTruthy();
    expect(projectNav().closest('[hidden]')).not.toBeNull();
    // One sidebar, never two side by side.
    expect(document.querySelectorAll('aside')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(projectNav().closest('[hidden]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Workspace' })).toBeTruthy();
  });

  it('puts the person back on the view they came from, not always on the workspace', async () => {
    const user = userEvent.setup();
    const app = await mount({ settings: 'Settings' });
    await user.click(screen.getByRole('button', { name: /^Reports/ }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(app.runtime.route.getState().view).toBe('reports');
    expect(projectNav().closest('[hidden]')).toBeNull();
  });

  it('leaves the project list alone for a view that does not ask for the sidebar', async () => {
    const user = userEvent.setup();
    await mount({});
    await user.click(screen.getByRole('button', { name: /^Activity/ }));
    expect(screen.getByRole('region', { name: 'activity' })).toBeTruthy();
    expect(projectNav().closest('[hidden]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('keeps the list hidden while any of two claims is held, and shows it when the last is released', async () => {
    const user = userEvent.setup();
    function Two({ both }: { both: boolean }) {
      return (
        <>
          <SidebarContent title="First" onBack={() => {}}>one</SidebarContent>
          {both ? <SidebarContent title="Second" onBack={() => {}}>two</SidebarContent> : null}
        </>
      );
    }
    function Host() {
      const host = useSidebarSlotHost();
      const [mode, setMode] = useState<'both' | 'one' | 'none'>('one');
      return (
        <SidebarSlotContext.Provider value={host.value}>
          <Sidebar replaced={host.replaced} slotRef={host.setSlot} />
          <button type="button" onClick={() => setMode('both')}>claim two</button>
          <button type="button" onClick={() => setMode('one')}>release second</button>
          <button type="button" onClick={() => setMode('none')}>release all</button>
          {mode === 'none' ? null : <Two both={mode === 'both'} />}
        </SidebarSlotContext.Provider>
      );
    }
    const harness = createHarness();
    render(<RuntimeProvider runtime={harness.runtime}><LayoutProvider><Host /></LayoutProvider></RuntimeProvider>);
    await screen.findByRole('navigation', { name: 'Projects', hidden: true });
    await until(() => projectNav().closest('[hidden]') !== null, 'the first claim to hide the list');
    await user.click(screen.getByRole('button', { name: 'claim two' }));
    expect(projectNav().closest('[hidden]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'release second' }));
    expect(projectNav().closest('[hidden]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'release all' }));
    expect(projectNav().closest('[hidden]')).toBeNull();
  });
});

describe('a view that replaces the sidebar, with the sidebar collapsed', () => {
  function Collapser() {
    const { update } = useLayout();
    const route = useRoute();
    return (
      <>
        <button type="button" onClick={() => update({ sidebarCollapsed: true })}>test: collapse</button>
        <button type="button" onClick={() => route.setView('settings')}>test: open settings</button>
      </>
    );
  }
  function CollapsedFrame() {
    const host = useSidebarSlotHost();
    const view = useRoute().view;
    return (
      <SidebarSlotContext.Provider value={host.value}>
        <Sidebar replaced={host.replaced} slotRef={host.setSlot} />
        <Collapser />
        {view === 'settings' ? <StandInView name="Settings" /> : null}
      </SidebarSlotContext.Provider>
    );
  }
  const aside = () => document.querySelector('aside[aria-label="Mini-Summa navigation"]') as HTMLElement;

  it('says when the sidebar is on screen: when it is not collapsed, or when a view holds it', () => {
    expect(sidebarShown(false, false)).toBe(true);
    expect(sidebarShown(true, false)).toBe(false);
    expect(sidebarShown(true, true)).toBe(true);
    expect(sidebarShown(false, true)).toBe(true);
  });

  it('shows the sidebar for the view that needs it (never a second column), and gives it back to the person\'s choice afterwards', async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    render(<RuntimeProvider runtime={harness.runtime}><LayoutProvider><CollapsedFrame /></LayoutProvider></RuntimeProvider>);
    await screen.findByRole('button', { name: /^GitManager(,|$)/ });
    await user.click(screen.getByRole('button', { name: 'test: collapse' }));
    expect(aside().hasAttribute('hidden')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'test: open settings' }));
    expect(aside().hasAttribute('hidden')).toBe(false);
    expect(within(aside()).getByRole('heading', { level: 2, name: 'Settings' })).toBeTruthy();
    expect(within(aside()).getByRole('button', { name: 'Section one' })).toBeTruthy();
    expect(document.querySelectorAll('aside')).toHaveLength(1);

    await user.click(within(aside()).getByRole('button', { name: 'Back' }));
    expect(aside().hasAttribute('hidden')).toBe(true);
  });
});
