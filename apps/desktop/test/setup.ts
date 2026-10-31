// Test environment for the renderer (jsdom). jsdom has no layout, no ResizeObserver, no PointerEvent and no canvas, so
// the few APIs the UI relies on are given small stand-ins here. Tests that care about geometry stub it themselves.
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// Async queries give up after a second by default. On a busy machine (several test runs at once) that is too tight for a screen that
// boots a whole app, and a longer wait costs nothing when the screen is ready.
configure({ asyncUtilTimeout: 3000 });

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// jsdom has MouseEvent but not PointerEvent; RTL falls back to a plain Event, which loses clientX and pointerId.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  vi.stubGlobal('PointerEvent', PointerEventPolyfill);
}

Element.prototype.scrollIntoView ??= () => {};
HTMLElement.prototype.setPointerCapture ??= () => {};
HTMLElement.prototype.releasePointerCapture ??= () => {};
HTMLElement.prototype.hasPointerCapture ??= () => false;
// jsdom does not run layout, so focusing needs no scrolling support either.
HTMLElement.prototype.scrollTo ??= () => {};

beforeEach(() => {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
});

afterEach(async () => {
  cleanup();
  // The toast store is module state; start every test with no toasts.
  const { resetToasts } = await import('../src/renderer/src/ui/Toaster');
  resetToasts();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
