import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, startHarness } from './harness.ts';
import type { Harness } from './harness.ts';

const open: Harness[] = [];
afterEach(async () => { while (open.length) { const h = open.pop()!; await h.stop().catch(() => {}); cleanup(h); } });
const boot = async (...a: Parameters<typeof startHarness>) => { const h = await startHarness(...a); open.push(h); return h; };

describe('core boot', () => {
  it('serves health, requires a token for everything else, and returns an application snapshot', async () => {
    const h = await boot();
    const health = await fetch(`${h.core.baseUrl}/api/v1/health`);
    expect(await health.json()).toMatchObject({ ok: true, name: 'mini-summa-core', apiVersion: 1 });
    expect((await fetch(`${h.core.baseUrl}/api/v1/state`)).status).toBe(401);
    const state = await h.client.call('system.state');
    expect(state.projects).toEqual([]);
    expect(state.system).toMatchObject({ mode: 'headless', version: '0.0.0-test' });
    expect(state.settings.chatgpt.mode).toBe('embedded');
  });

  it('keeps projects, conversations and settings across a restart', async () => {
    const h = await boot();
    const { project } = await h.project('GitManager', { conversations: ['https://chatgpt.com/c/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'] });
    await h.client.call('settings.update', { body: { layout: { landscapeRatio: 0.62 } } });
    const again = await h.restart();
    open.push(again);
    const projects = await again.client.call('projects.list');
    expect(projects.map((p) => p.name)).toEqual(['GitManager']);
    expect(projects[0].id).toBe(project.id);
    const convs = await again.client.call('conversations.list', { params: { id: project.id } });
    expect(convs).toHaveLength(1);
    expect(projects[0].preferredConversationId).toBe(convs[0].id);
    expect((await again.client.call('settings.get')).layout.landscapeRatio).toBe(0.62);
  });
});
