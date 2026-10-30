// The native ChatGPT view draws above everything. Anything floating over it must ask for it to be hidden, and several
// overlays at once must not fight: the view hides when the first opens and comes back when the last one closes.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setNativeBounds } from '../../src/renderer/src/app/nativeBounds';
import { NativeProvider } from '../../src/renderer/src/app/native';
import { acquireNativeOverlay, overlayCount } from '../../src/renderer/src/ui/nativeOverlay';
import { ConfirmDialog, Dialog, IconButton, Menu, Tooltip } from '../../src/renderer/src/ui';
import { createFakeNative } from './helpers';

afterEach(() => { setNativeBounds(null); });

const calls = (fn: unknown): boolean[] => (fn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as boolean);

describe('acquireNativeOverlay', () => {
  it('tells the host once when the first overlay opens and once when the last one closes', () => {
    const host = { setOverlayActive: vi.fn(async () => {}) };
    const releaseA = acquireNativeOverlay(host);
    const releaseB = acquireNativeOverlay(host);
    expect(calls(host.setOverlayActive)).toEqual([true]);
    expect(overlayCount(host)).toBe(2);
    releaseA();
    expect(calls(host.setOverlayActive)).toEqual([true]);
    releaseB();
    expect(calls(host.setOverlayActive)).toEqual([true, false]);
    expect(overlayCount(host)).toBe(0);
  });

  it('counts a release only once, however often it is called', () => {
    const host = { setOverlayActive: vi.fn(async () => {}) };
    const a = acquireNativeOverlay(host);
    const b = acquireNativeOverlay(host);
    a(); a(); a();
    expect(overlayCount(host)).toBe(1);
    expect(calls(host.setOverlayActive)).toEqual([true]);
    b();
    expect(calls(host.setOverlayActive)).toEqual([true, false]);
  });

  it('can be used again after everything closed', () => {
    const host = { setOverlayActive: vi.fn(async () => {}) };
    acquireNativeOverlay(host)();
    acquireNativeOverlay(host)();
    expect(calls(host.setOverlayActive)).toEqual([true, false, true, false]);
  });

  it('keeps separate counts for separate hosts', () => {
    const one = { setOverlayActive: vi.fn(async () => {}) };
    const two = { setOverlayActive: vi.fn(async () => {}) };
    acquireNativeOverlay(one);
    acquireNativeOverlay(two);
    expect(calls(one.setOverlayActive)).toEqual([true]);
    expect(calls(two.setOverlayActive)).toEqual([true]);
  });

  it('survives a host that rejects or throws', async () => {
    const rejecting = { setOverlayActive: vi.fn(async () => { throw new Error('gone'); }) };
    const throwing = { setOverlayActive: vi.fn(() => { throw new Error('gone'); }) };
    expect(() => acquireNativeOverlay(rejecting)()).not.toThrow();
    expect(() => acquireNativeOverlay(throwing as never)()).not.toThrow();
    await Promise.resolve();
  });
});

describe('dialogs hide the native view', () => {
  function Harness({ fake }: { fake: ReturnType<typeof createFakeNative> }) {
    const [first, setFirst] = useState(false);
    const [second, setSecond] = useState(false);
    return (
      <NativeProvider native={fake.native}>
        <button type="button" onClick={() => setFirst(true)}>open first</button>
        <Dialog open={first} onClose={() => setFirst(false)} title="First">
          <button type="button" onClick={() => setSecond(true)}>open second</button>
          <button type="button" onClick={() => setFirst(false)}>close first</button>
        </Dialog>
        <ConfirmDialog open={second} title="Second" description="Sure?" confirmLabel="Do it" onConfirm={() => setSecond(false)} onCancel={() => setSecond(false)} />
      </NativeProvider>
    );
  }

  it('hides the view while a dialog is open and shows it again when it closes', async () => {
    const user = userEvent.setup();
    const fake = createFakeNative();
    render(<Harness fake={fake} />);
    expect(calls(fake.native.chatgpt.setOverlayActive)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'open first' }));
    expect(calls(fake.native.chatgpt.setOverlayActive)).toEqual([true]);
    await user.click(screen.getByRole('button', { name: 'close first' }));
    expect(calls(fake.native.chatgpt.setOverlayActive)).toEqual([true, false]);
  });

  it('stays hidden while two dialogs are stacked and returns only when both are gone', async () => {
    const user = userEvent.setup();
    const fake = createFakeNative();
    render(<Harness fake={fake} />);
    await user.click(screen.getByRole('button', { name: 'open first' }));
    await user.click(screen.getByRole('button', { name: 'open second' }));
    expect(calls(fake.native.chatgpt.setOverlayActive)).toEqual([true]); // not told twice
    await user.click(screen.getByRole('button', { name: 'Cancel' })); // closes the top one
    expect(calls(fake.native.chatgpt.setOverlayActive)).toEqual([true]); // the first dialog still needs it hidden
    await user.click(screen.getByRole('button', { name: 'close first' }));
    expect(calls(fake.native.chatgpt.setOverlayActive)).toEqual([true, false]);
  });
});

describe('menus and tooltips hide the native view only when they would be drawn under it', () => {
  // jsdom has no layout; give floating surfaces a size so overlap can be worked out.
  const sized = () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(180);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(90);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
  };
  const menu = (fake: ReturnType<typeof createFakeNative>) => render(
    <NativeProvider native={fake.native}>
      <Menu
        label="Test menu"
        trigger={(p) => <button type="button" ref={p.ref as never} onClick={p.onClick} aria-haspopup="menu" aria-expanded={p['aria-expanded']}>open menu</button>}
        items={[{ label: 'One', onSelect: () => {} }, { label: 'Two', onSelect: () => {} }]}
      />
    </NativeProvider>,
  );

  it('hides it for a menu that opens over it', async () => {
    sized();
    setNativeBounds({ x: 0, y: 0, width: 1200, height: 800 });
    const fake = createFakeNative();
    menu(fake);
    await userEvent.setup().click(screen.getByRole('button', { name: 'open menu' }));
    await screen.findByRole('menu');
    expect(calls(fake.native.chatgpt.setOverlayActive)).toEqual([true]);
    await userEvent.setup().keyboard('{Escape}');
    expect(calls(fake.native.chatgpt.setOverlayActive)).toEqual([true, false]);
  });

  it('leaves it alone for a menu that opens somewhere else', async () => {
    sized();
    setNativeBounds({ x: 800, y: 600, width: 100, height: 100 }); // far from where the menu opens
    const fake = createFakeNative();
    menu(fake);
    await userEvent.setup().click(screen.getByRole('button', { name: 'open menu' }));
    await screen.findByRole('menu');
    expect(calls(fake.native.chatgpt.setOverlayActive)).toEqual([]);
  });

  it('leaves it alone when the native view is not showing at all', async () => {
    sized();
    setNativeBounds(null);
    const fake = createFakeNative();
    menu(fake);
    await userEvent.setup().click(screen.getByRole('button', { name: 'open menu' }));
    await screen.findByRole('menu');
    expect(calls(fake.native.chatgpt.setOverlayActive)).toEqual([]);
  });

  it('hides it for a tooltip that cannot be placed clear of it', async () => {
    sized();
    setNativeBounds({ x: 0, y: 0, width: 1200, height: 800 });
    const fake = createFakeNative();
    render(
      <NativeProvider native={fake.native}>
        <Tooltip content="Reload"><IconButton label="Reload" icon="refresh" tooltip={false} /></Tooltip>
      </NativeProvider>,
    );
    await userEvent.setup().tab();
    await screen.findByRole('tooltip');
    expect(calls(fake.native.chatgpt.setOverlayActive)).toEqual([true]);
  });
});
