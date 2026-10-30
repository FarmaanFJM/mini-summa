// Composition root: builds every service, wires them together and owns the lifecycle.
//
// Order matters in exactly two places:
//  * The orchestrator subscribes to the Claude layer BEFORE sessions.init(), so history replayed from the raw log
//    reaches it (flagged `replay`, which never notifies) and nothing captured earlier is missed.
//  * The HTTP server listens LAST, after state has been rebuilt, so a client never sees an empty application.
import fs from 'node:fs';
import path from 'node:path';
import { API_VERSION, unavailableBridge } from '@minisumma/shared';
import type { ChatGptOpenResult, Counts, NativeBridge, SystemInfo } from '@minisumma/shared';
import { openDatabase } from '@minisumma/storage';
import { createEventBus } from './bus.ts';
import { createEnvironmentsService, createManagedManager, createSessionsService } from './claude/index.ts';
import { systemClock } from './contracts.ts';
import type { Core, CoreBase, CoreOptions, ExtensionBridge, Logger, SettingsService } from './contracts.ts';
import { createHttpServer } from './http/server.ts';
import { HttpListenError } from './http/types.ts';
import type { HttpServer } from './http/types.ts';
import { createDataService, createDevicesService, createFcmProvider, createProjectsService, createSettingsService, createTailscaleService } from './infra/index.ts';
import { createHooksService } from './infra/hooks.ts';
import { createOrchestrator } from './orchestrator.ts';
import type { Orchestrator } from './orchestrator.ts';
import { createActionsService, createActivityService, createDeliveriesService, createNotificationsService, createReportsService } from './workflow/index.ts';

const PRIVATE_SUBDIRS = ['spool', 'logs', 'backups', 'managed-settings', 'secrets', 'electron-profile'];
const PRIVATE_FILES = ['mini-summa.db', 'mini-summa.db-wal', 'mini-summa.db-shm', 'registry.json'];

/**
 * Reports, prompts, tool inputs and push tokens live here, so on POSIX systems only the owner may read the data
 * directory. (On Windows the directory sits in the user's own profile, whose NTFS permissions already exclude other
 * users, and POSIX modes do not apply.)
 */
export function restrictPermissions(dataDir: string): void {
  if (process.platform === 'win32') return;
  const attempt = (p: string, mode: number) => { try { fs.chmodSync(p, mode); } catch { /* does not exist yet */ } };
  const dirs = (root: string, depth: number) => {
    attempt(root, 0o700);
    if (depth <= 0) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) dirs(path.join(root, e.name), depth - 1);
  };
  attempt(dataDir, 0o700);
  for (const d of PRIVATE_SUBDIRS) dirs(path.join(dataDir, d), 3);
  for (const f of PRIVATE_FILES) attempt(path.join(dataDir, f), 0o600);
}

/**
 * On Windows nothing above applies (no POSIX modes), so what keeps other accounts out of the data directory is the folder's own
 * permissions. A folder inside the user's profile inherits the profile's, which exclude other users; a folder anywhere else
 * (another drive, a share) inherits from its drive or share, where "Authenticated Users" can often read. Returns the sentence to log
 * when the directory is outside the profile (null when it is inside, when the profile is unknown, and on other platforms).
 */
export function dataDirAdvice(dataDir: string, env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null;
  const profile = env.USERPROFILE?.trim();
  if (!profile) return null;
  const rel = path.win32.relative(profile, dataDir);
  if (rel !== '' && (rel === '..' || rel.startsWith('..\\') || path.win32.isAbsolute(rel))) {
    const share = /^[\\/]{2}/.test(dataDir);
    return `The data directory ${dataDir} is outside your Windows profile (${profile}), so it does not get the profile's protection: on Windows Mini-Summa relies on the folder's own permissions to keep other accounts out of the database, the hook spool, the backups and the push key, and a folder on another drive or a share may be readable by other accounts. Use the default folder, or remove access for everyone but your account.${share ? ' It is also on a network share, where the database uses the slower rollback journal because the write-ahead log does not work there.' : ''}`;
  }
  return null;
}

/** Preferred port, so the browser extension and `tailscale serve` can rely on a stable address. */
export const DEFAULT_PORT = 47811;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export function createFileLogger(dataDir: string, echo: 'none' | 'warn' | 'all' = 'warn'): Logger {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'core.log');
  try {
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, path.join(dir, 'core.log.1'));
  } catch { /* no log yet */ }
  const write = (level: string, msg: string, data?: Record<string, unknown>) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${data ? ` ${safeJson(data)}` : ''}\n`;
    try { fs.appendFileSync(file, line, { mode: 0o600 }); } catch { /* logging must never break the core */ }
    if (echo === 'all' || (echo === 'warn' && (level === 'WARN' || level === 'ERROR'))) process.stderr.write(line);
  };
  return {
    debug: () => {},
    info: (m, d) => write('INFO', m, d),
    warn: (m, d) => write('WARN', m, d),
    error: (m, d) => write('ERROR', m, d),
  };
}

function safeJson(data: Record<string, unknown>): string {
  try { return JSON.stringify(data); } catch { return '"[unserializable]"'; }
}

const NO_OPEN: ChatGptOpenResult = { ok: false, mode: 'none', opened: false, focused: false, verified: null, finalUrl: null, title: null, note: null };

/**
 * The host (Electron) knows the embedded view. Everything about external browsers is composed here, from settings and
 * the extension bridge, so the delivery service asks one object and never knows which mode is active.
 */
export function composeNative(host: NativeBridge, settings: Pick<SettingsService, 'get'>, bridge: () => ExtensionBridge | null): NativeBridge {
  const embedded = () => settings.get().chatgpt.mode === 'embedded' && host.capabilities().chatgptEmbedded;

  async function openOutside(url: string): Promise<ChatGptOpenResult> {
    const wantsExtension = settings.get().chatgpt.externalBrowser === 'extension';
    const ext = bridge();
    if (wantsExtension && ext?.connected()) {
      const viaExtension = await ext.openOrFocus(url);
      if (viaExtension.ok) return viaExtension;
    }
    if (host.capabilities().openExternal) {
      await host.openExternal(url);
      return {
        ...NO_OPEN, ok: true, mode: 'external', opened: true,
        note: wantsExtension
          ? 'The browser extension is not connected, so the address was opened in your default browser. A tab for this conversation may already be open.'
          : 'Opened in your default browser. Mini-Summa cannot see or focus the tab, so check that it is the right conversation.',
      };
    }
    return { ...NO_OPEN, note: 'No browser can be opened from here. Open the conversation yourself from its address.' };
  }

  return {
    capabilities: () => ({ ...host.capabilities(), extensionBridge: Boolean(bridge()?.connected()) }),
    chatgpt: {
      open: (url, opts) => (embedded() ? host.chatgpt.open(url, opts) : openOutside(url)),
      verify: async (url) => (embedded() ? host.chatgpt.verify(url)
        : { ...NO_OPEN, note: 'External browser mode cannot check a page. Open it and confirm it is the right conversation yourself.' }),
      state: () => (embedded() ? host.chatgpt.state()
        : { mode: 'external', status: 'idle', url: null, title: null, canGoBack: false, canGoForward: false, note: null }),
    },
    clipboard: host.clipboard,
    notify: (n) => host.notify(n),
    openExternal: (url) => host.openExternal(url),
    saveTextFile: (o) => host.saveTextFile(o),
  };
}

export async function createCore(options: CoreOptions): Promise<Core> {
  const clock = options.clock ?? systemClock;
  const dataDir = path.resolve(options.dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  restrictPermissions(dataDir);
  const log = options.log ?? createFileLogger(dataDir, options.mode === 'headless' ? 'all' : 'warn');
  const advice = dataDirAdvice(dataDir, process.env);
  if (advice) log.warn(advice);
  const { db } = openDatabase(path.join(dataDir, 'mini-summa.db'));
  const bus = createEventBus();
  const base: CoreBase = { db, bus, clock, log, version: options.version, mode: options.mode, dataDir };
  const overrides = options.overrides ?? {};
  const host = options.native ?? unavailableBridge();
  const startedAt = clock.now().toISOString();

  const settings = createSettingsService({ base });
  const projects = createProjectsService({ base, settings, hostEnv: overrides.hostEnv });
  const environments = createEnvironmentsService({ base, settings, overrides });
  const managed = createManagedManager({ base, environments, overrides });
  const sessions = createSessionsService({ base, settings, projects, environments, managed, overrides });
  const devices = createDevicesService({ base });
  const push = createFcmProvider({ base, settings, overrides });

  let bridge: ExtensionBridge | null = null;
  const native = composeNative(host, settings, () => bridge);

  // `countsNow` is late-bound: the activity service needs it before the services it counts exist.
  let countsNow: () => Counts = () => ({ unreadActivity: 0, actionsNeeded: 0, pendingActions: 0, reportsAwaitingHandoff: 0, liveSessions: 0 });
  const activity = createActivityService({ base, fullCounts: () => countsNow() });
  const notifications = createNotificationsService({ base, settings, projects, devices, native, push });

  let orchestrator: Orchestrator | null = null;
  const reports = createReportsService({ base, onCreated: (report, ctx) => orchestrator?.onReportCreated(report, ctx) });
  const deliveries = createDeliveriesService({ base, settings, projects, reports, sessions, native });
  const actions = createActionsService({ base, settings, sessions, activity, devices, deliveries, reports, recordPermissionActivity: false });
  orchestrator = createOrchestrator({ base, settings, sessions, reports, deliveries, activity, notifications, actions });
  const hooks = createHooksService({ base, environments });

  let port = 0;
  const tailscale = createTailscaleService({ base, settings, getPort: () => port, overrides });
  const data = createDataService({ base, settings, activity, notifications, reports, deliveries });

  countsNow = (): Counts => {
    const own = activity.counts();
    const pending = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'pending'")?.n ?? 0;
    const awaiting = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE state NOT IN ('user_confirmed_sent', 'user_discarded')")?.n ?? 0;
    const live = sessions.list().filter((s) => s.availability === 'live').length;
    return { ...own, pendingActions: pending, reportsAwaitingHandoff: awaiting, liveSessions: live };
  };

  const system = (): SystemInfo => ({
    name: 'mini-summa-core', version: options.version, apiVersion: API_VERSION, mode: options.mode, platform: process.platform,
    startedAt, nativeCapabilities: native.capabilities(),
  });

  // Keep every client's badge numbers current without each service having to know about counts.
  let lastCounts = '';
  let countsTimer: ReturnType<typeof setTimeout> | null = null;
  const emitCountsSoon = () => {
    if (countsTimer) return;
    countsTimer = setTimeout(() => {
      countsTimer = null;
      try {
        const counts = countsNow();
        const json = JSON.stringify(counts);
        if (json !== lastCounts) { lastCounts = json; bus.emit({ type: 'counts', counts }); }
      } catch (err) { log.warn('could not compute counts', { error: String(err) }); }
    }, 50);
    countsTimer.unref?.();
  };
  const offCounts = bus.subscribe((_seq, event) => {
    switch (event.type) {
      case 'activity.added': case 'activity.updated': case 'activity.read': case 'action.upserted':
      case 'delivery.upserted': case 'session.upserted': case 'session.removed': emitCountsSoon(); break;
      default: break;
    }
  });

  let server: HttpServer | null = null;
  let stopOrchestrator: (() => void) | null = null;
  let started = false;
  let stopped = false;

  const buildServer = (listenPort: number): HttpServer => createHttpServer({
    base, port: listenPort, uiDir: options.uiDir, counts: countsNow, system, native,
    services: { settings, projects, sessions, environments, activity, notifications, reports, deliveries, actions, devices, hooks, tailscale, data, push },
  });

  async function listen(): Promise<{ port: number; baseUrl: string }> {
    const requested = options.port;
    const first = requested ?? DEFAULT_PORT;
    let candidate = buildServer(first);
    try {
      const bound = await candidate.start();
      server = candidate;
      return bound;
    } catch (err) {
      // A preferred port that is taken falls back to any free one. An explicit port that is taken is an error.
      if (!(err instanceof HttpListenError) || err.code !== 'EADDRINUSE' || requested !== undefined) throw err;
      log.warn('preferred port is in use, picking a free one', { port: first });
      candidate = buildServer(0);
      const bound = await candidate.start();
      server = candidate;
      return bound;
    }
  }

  let baseUrl = '';

  return {
    get baseUrl() { return baseUrl; },
    get desktopToken() { return devices.desktopToken; },
    base,
    services: { settings, projects, sessions, environments, activity, notifications, reports, deliveries, actions, devices, hooks, tailscale, data },
    counts: countsNow,

    async start() {
      if (started) return;
      started = true;
      stopOrchestrator = orchestrator!.start();
      await sessions.init();
      restrictPermissions(dataDir);
      orchestrator!.reconcile();
      deliveries.recoverAfterRestart();
      actions.init();
      const bound = await listen();
      port = bound.port;
      baseUrl = bound.baseUrl;
      bridge = server!.extensionBridge;
      restrictPermissions(dataDir);
      tailscale.init();
      emitCountsSoon();
      log.info('core started', { baseUrl, mode: options.mode, version: options.version });
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      if (countsTimer) clearTimeout(countsTimer);
      offCounts();
      try { await server?.stop(); } catch (err) { log.warn('http server did not stop cleanly', { error: String(err) }); }
      try { await tailscale.shutdown(); } catch (err) { log.warn('tailscale did not shut down cleanly', { error: String(err) }); }
      actions.shutdown();
      stopOrchestrator?.();
      try { await sessions.shutdown(); } catch (err) { log.warn('sessions did not shut down cleanly', { error: String(err) }); }
      (environments as { dispose?: () => void }).dispose?.();
      db.close();
      restrictPermissions(dataDir);
      log.info('core stopped');
    },
  };
}
