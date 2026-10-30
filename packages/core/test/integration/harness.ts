// Integration harness: the REAL core (SQLite, services, HTTP/WebSocket server, hooks, ingestion, PTY manager) driven
// through the public client SDK, with the fake Claude CLI standing in for `claude` and a recording fake for the host.
// Nothing here mocks the core; only the two things outside it (Claude and the desktop shell) are fakes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MiniSummaClient } from '@minisumma/shared';
import type { Conversation, Project, SessionKey, SessionView } from '@minisumma/shared';
import { createCore, createFileLogger } from '../../src/core.ts';
import type { Core, CoreOptions } from '../../src/contracts.ts';
import { createFakeNative } from '../../src/testing/fake-native.ts';
import type { FakeNative } from '../../src/testing/fake-native.ts';
import { FAKE_CLAUDE_SCRIPT } from '../../src/testing/fake-claude/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_SCRIPT = path.resolve(here, '../../../claude-integration/src/hook/capture.mjs');

export interface Harness {
  core: Core;
  client: MiniSummaClient;
  native: FakeNative;
  dataDir: string;
  stateDir: string;
  root: string;
  /** Create a project whose repository folder really exists. */
  project(name: string, opts?: { conversations?: string[]; github?: string }): Promise<{ project: Project; dir: string; conversations: Conversation[] }>;
  /** Starts a managed session and, unless told otherwise, waits until Claude has finished starting (its first hook arrived). */
  start(projectId: string, opts?: { name?: string; waitReady?: boolean }): Promise<SessionView>;
  /** Type into the terminal of a managed session the way a person at the keyboard would. */
  type(key: SessionKey, text: string, opts?: { submit?: boolean }): Promise<void>;
  waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs?: number): Promise<T>;
  restart(): Promise<Harness>;
  stop(): Promise<void>;
}

export function wrapperFor(dir: string, stateDir: string): string {
  const file = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE_SCRIPT}" --fake-state-dir "${stateDir}" "$@"\n`, { mode: 0o755 });
  return file;
}

export async function startHarness(opts: { dataDir?: string; root?: string; core?: Partial<CoreOptions>; spoolPollMs?: number } = {}): Promise<Harness> {
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ms-int-'));
  const dataDir = opts.dataDir ?? path.join(root, 'data');
  const stateDir = path.join(root, 'fake-claude-state');
  fs.mkdirSync(stateDir, { recursive: true });
  const bin = wrapperFor(root, stateDir);
  const native = createFakeNative();
  const { overrides: extraOverrides, ...coreOptions } = opts.core ?? {};
  const overrides: NonNullable<CoreOptions['overrides']> = {
    claudeBin: bin, nodeRuntime: { command: process.execPath, runAsNode: false }, captureScript: CAPTURE_SCRIPT,
    hostEnv: 'posix', discoveryIntervalMs: 60_000, spoolPollMs: opts.spoolPollMs ?? 60, homeDir: path.join(root, 'home'), ...extraOverrides,
  };
  // The tests must never reach the real Claude Code CLI (it is installed on developer machines and authenticated).
  if (overrides.claudeBin !== bin) throw new Error('integration tests must run against the fake Claude CLI');
  const core = await createCore({
    dataDir, mode: 'headless', version: '0.0.0-test', port: 0, native, log: createFileLogger(dataDir, 'none'),
    ...coreOptions, overrides,
  });
  await core.start();
  const client = new MiniSummaClient({ baseUrl: core.baseUrl, token: core.desktopToken, clientName: 'integration-test', WebSocket: WebSocket as never });
  client.events.connect();

  const waitFor: Harness['waitFor'] = async (what, fn, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try { const v = await fn(); if (v) return v as never; } catch (err) { last = err; }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timed out waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
  };

  const attached = new Map<SessionKey, { input(data: string): boolean }>();
  const h: Harness = {
    core, client, native, dataDir, stateDir, root,
    async project(name, o = {}) {
      const dir = path.join(root, 'repos', name.replace(/[^A-Za-z0-9_-]/g, '_'));
      fs.mkdirSync(dir, { recursive: true });
      const project = await client.call('projects.create', { body: { name, githubRepo: o.github, roots: [{ path: dir }] } });
      const conversations: Conversation[] = [];
      for (const url of o.conversations ?? []) conversations.push(await client.call('conversations.add', { params: { id: project.id }, body: { url } }));
      return { project: await client.call('projects.get', { params: { id: project.id } }), dir, conversations };
    },
    async start(projectId, o = {}) {
      const started = await client.call('sessions.start', { params: { id: projectId }, body: { mode: 'new', name: o.name } });
      if (o.waitReady === false) return started;
      return waitFor(`session ${started.key} to finish starting`, async () => {
        const v = await client.call('sessions.get', { params: { key: started.key } });
        return v.state !== 'unknown' ? v : undefined;
      });
    },
    async type(key, text, o = {}) {
      let t = attached.get(key);
      if (!t) {
        t = client.terminal.attach(key, { cols: 100, rows: 30 }, { onAttached() {}, onData() {}, onExit() {}, onError() {} });
        attached.set(key, t);
        await new Promise((r) => setTimeout(r, 120));
      }
      t.input(text);
      if (o.submit !== false) { await new Promise((r) => setTimeout(r, 60)); t.input('\r'); }
    },
    waitFor,
    async restart() {
      await h.stop();
      return startHarness({ ...opts, dataDir, root });
    },
    async stop() {
      client.close();
      await core.stop();
    },
  };
  return h;
}

export function cleanup(h: Harness): void {
  try { fs.rmSync(h.root, { recursive: true, force: true }); } catch { /* best effort */ }
}
