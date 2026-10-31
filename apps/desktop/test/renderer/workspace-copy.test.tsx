// The words of the workspace follow the house rules (P13: no em dash, and no en dash either), in the source and in what is on screen:
// labels, tooltips, aria labels, notices, menus and the demo data. The characters are built from codes so that this file holds none.
import fs from 'node:fs';
import path from 'node:path';
import { screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearNativeBounds } from '../../src/renderer/src/app/nativeBounds';
import { createFakeNative, renderApp, stubWorkspaceGeometry } from './helpers';

vi.mock('../../src/renderer/src/features/activity', async () => ({ default: (await import('./stubViews')).ActivityStandIn }));
vi.mock('../../src/renderer/src/features/reports', async () => ({ default: (await import('./stubViews')).ReportsStandIn }));
vi.mock('../../src/renderer/src/features/settings', async () => ({ default: (await import('./stubViews')).SettingsStandIn }));

afterEach(() => { clearNativeBounds(); vi.restoreAllMocks(); });

const EM_DASH = String.fromCharCode(8212);
const EN_DASH = String.fromCharCode(8211);
const DASH = new RegExp(`[${EM_DASH}${EN_DASH}]`);

const SRC = path.resolve(__dirname, '../../src/renderer/src');
const WORKSPACE_FILES = [
  ...fs.readdirSync(path.join(SRC, 'features/workspace')).map((f) => path.join('features/workspace', f)),
  'dev/demoNative.ts', 'app/route.ts', 'app/uiState.ts', 'app/uiSync.ts', 'app/native.ts', 'app/nativeBounds.ts',
];

/** Every piece of text a person can read or hear in what is on screen: its words, and the names and tips of its controls. */
function copyOnScreen(): string[] {
  const found: string[] = [];
  for (const el of document.body.querySelectorAll('*')) {
    for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) {
      const value = el.getAttribute(attribute);
      if (value) found.push(value);
    }
    for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) found.push(node.textContent);
  }
  return found;
}
const dashes = () => copyOnScreen().filter((t) => DASH.test(t));

describe('the source of the workspace and what it stands on', () => {
  it('covers the workspace, its demo native, and the files that remember the cloud page', () => {
    expect(WORKSPACE_FILES.length).toBeGreaterThan(20);
    for (const f of WORKSPACE_FILES) expect(fs.existsSync(path.join(SRC, f)), f).toBe(true);
  });

  it('has no em dash and no en dash anywhere, in copy or in comments', () => {
    const offenders = WORKSPACE_FILES.flatMap((f) => fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').map((text, i) => ({ f, line: i + 1, text })).filter((l) => DASH.test(l.text)));
    expect(offenders).toEqual([]);
  });

  it('has no thick left border and no decoration the guidance forbids in its stylesheet', () => {
    const css = fs.readFileSync(path.join(SRC, 'features/workspace/workspace.css'), 'utf8');
    expect(css).not.toMatch(/border-left\s*:\s*[^;]*\b(solid|[1-9]\d*px)/);
    expect(css).not.toMatch(/gradient|box-shadow\s*:[^;]*rgba?\([^)]*\)\s*(0|[1-9]\d*px)\s+0\s+[1-9]/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // tokens only, never a colour of its own
  });
});

describe('what is on screen', () => {
  it('has none in the workspace, its menus and its tooltips', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    await renderApp({ native: createFakeNative() });
    expect(dashes()).toEqual([]);
    await user.hover(screen.getByRole('radio', { name: 'Claude' }));
    await screen.findByRole('tooltip');
    expect(dashes()).toEqual([]);
    await user.unhover(screen.getByRole('radio', { name: 'Claude' }));
    await user.click(screen.getByRole('button', { name: 'Layout: Automatic' }));
    expect(dashes()).toEqual([]);
    await user.keyboard('{Escape}');
    await user.click(within(screen.getByRole('region', { name: 'Claude' })).getByRole('button', { name: 'New session' }));
    expect(dashes()).toEqual([]);
  });

  it.each([
    ['no folder and no repository', { name: 'Nothing', roots: [] as { path: string }[] }],
    ['a folder only', { name: 'Folder', roots: [{ path: 'C:\\Dev\\folder' }] }],
    ['a repository only', { name: 'Repo', roots: [] as { path: string }[], githubRepo: 'acme/repo' }],
    ['a linked ChatGPT Project', { name: 'Linked', roots: [] as { path: string }[], chatgptProject: { url: 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-linked-one/project' } }],
  ])('has none in the empty panes and the menu of a project with %s', async (_label, body) => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const app = await renderApp({ native: createFakeNative() });
    await app.demo.call('projects.create', { body });
    await user.click(await screen.findByRole('button', { name: new RegExp(`^${body.name}(,|$)`) }));
    await screen.findByRole('heading', { level: 1, name: body.name });
    expect(dashes()).toEqual([]);
    await user.click(within(screen.getByRole('region', { name: 'Claude' })).getByRole('button', { name: 'New session' }));
    expect(dashes()).toEqual([]);
  });

  it('has none in the Cloud tab, whatever the page says', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    const fake = createFakeNative();
    await renderApp({ native: fake });
    await user.click(within(screen.getByRole('region', { name: 'Claude' })).getByRole('tab', { name: /^Cloud/ }));
    for (const state of [
      { status: 'ready' as const, url: 'https://claude.ai/code' },
      { status: 'loading' as const },
      { status: 'login_required' as const, note: null },
      { status: 'blocked' as const, note: null },
      { status: 'error' as const, note: null },
      { status: 'login_required' as const, note: 'Claude asked for a new sign in.' },
    ]) {
      act(() => fake.emitClaudeView(state));
      await waitFor(() => expect(dashes()).toEqual([]));
    }
  });

  it('has none in the Cloud tab where the page cannot be embedded', async () => {
    stubWorkspaceGeometry();
    const user = userEvent.setup();
    for (const native of [createFakeNative({ embedded: false }), createFakeNative({ claudeWeb: false })]) {
      const app = await renderApp({ native });
      await user.click(within(screen.getByRole('region', { name: 'Claude' })).getByRole('tab', { name: /^Cloud/ }));
      expect(dashes()).toEqual([]);
      app.unmount();
      app.runtime.dispose();
    }
  });
});
