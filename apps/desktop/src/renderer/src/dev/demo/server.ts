// An in-memory Mini-Summa core. It answers the same routes with the same shapes (validating bodies with the real zod
// schemas), mutates its data plausibly and publishes numbered events, so the renderer cannot tell it from the real thing.
import {
  ApiError, buildReportMessage, encodePairingPayload, mergeSettings, parseChatGptProjectLink, parseChatGptUrl, routes, splitMessage, suggestConversationTitle,
} from '@minisumma/shared';
import type {
  ActivityEvent, ChatGptOpenResult, Conversation, Counts, Delivery, DeliveryDetail, DeliveryState, EnvId, Project, ProjectRoot, Report,
  RouteInput, RouteName, RouteOutput, ServerMessage, SessionKey, SessionView, StateSnapshot, TailscaleStatus,
} from '@minisumma/shared';
import { isAwaitingHandoff } from '../../app/selectors';
import { installFeatureHandlers } from './features-handlers';
import { createSeed, IDS } from './seed';
import type { DemoData } from './seed';
import { declinedScreen, EchoShell, readyScreen, replayFor, TrustShell } from './terminalSim';
import { MemoryTransport } from './transport';

type Handler<K extends RouteName> = (input: RouteInput<K>) => RouteOutput<K> | Promise<RouteOutput<K>>;
type Handlers = { [K in RouteName]?: Handler<K> };

export interface DemoServerOptions {
  seed?: DemoData;
  /** Artificial delay per call, to make loading states visible. Default 0. */
  latencyMs?: number;
}

const uid = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const nowIso = (): string => new Date().toISOString();
const ok = { ok: true } as const;

function parseBody(name: RouteName, body: unknown): any {
  const schema = (routes[name] as { body?: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { message: string; path: PropertyKey[] }[] } } } }).body;
  if (!schema) return body;
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const issue = result.error?.issues[0];
  const where = issue?.path.length ? `${String(issue.path[0])}: ` : '';
  throw new ApiError(400, 'validation_error', `${where}${issue?.message ?? 'The request is not valid.'}`);
}

function inferEnv(path: string, fallback: EnvId): EnvId {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return 'win';
  return fallback.startsWith('wsl:') || fallback === 'posix' ? fallback : 'wsl:Ubuntu';
}

export class DemoServer {
  data: DemoData;
  readonly transport: MemoryTransport;
  /** Scenario switches used by screenshots and tests. */
  stallSnapshot = false;
  failSnapshot: string | null = null;
  /** Called when the app asks to open a conversation, so a simulated native view can follow. */
  onOpen: ((url: string) => void) | null = null;
  /** New sessions begin on Claude's "Do you trust the files in this folder?" screen and stay "Starting" until it is answered. */
  trustPrompt = false;
  /** How long a started or resumed terminal takes to show its first sign of life (the first hook). */
  firstHookDelayMs = 400;
  private latencyMs: number;
  private readonly terminals = new Map<SessionKey, { shell: EchoShell; seq: number }>();
  private readonly trusting = new Map<SessionKey, TrustShell>();

  constructor(options: DemoServerOptions = {}) {
    this.data = options.seed ?? createSeed();
    this.latencyMs = options.latencyMs ?? 0;
    this.transport = new MemoryTransport({
      onTerminal: (message, reply, socket) => {
        const key = message.key;
        const session = this.data.sessions.find((s) => s.key === key);
        if (message.t === 'term.attach') {
          if (!session || session.origin !== 'managed') { reply({ t: 'term.error', key, code: 'not_managed', message: 'Only sessions started by Mini-Summa have a terminal.' }); return; }
          if (session.availability === 'disconnected' || (session.availability !== 'live' && !session.terminal?.exited)) {
            reply({ t: 'term.error', key, code: 'no_terminal', message: 'The terminal of this session is not connected.' }); return;
          }
          const state = this.terminals.get(key) ?? { shell: new EchoShell(), seq: 1 };
          this.terminals.set(key, state);
          socket.attached.add(key);
          state.seq += 1;
          reply({ t: 'term.attached', key, replay: this.trusting.get(key)?.screen() ?? replayFor(session, IDS_FOR_REPLAY), seq: state.seq, cols: message.cols, rows: message.rows });
          if (session.terminal?.exited) {
            reply({ t: 'term.exit', key, code: session.state === 'error' ? 1 : 0, signal: null, at: session.termination?.at ?? nowIso(), reason: session.termination?.reason ?? 'The session ended.' });
          }
        } else if (message.t === 'term.input') {
          const state = this.terminals.get(key);
          if (!state || !session || session.availability !== 'live') return;
          const trust = this.trusting.get(key);
          if (trust) { this.answerTrust(session, trust, message.data, state); return; }
          const echo = state.shell.feed(message.data);
          if (echo) { state.seq += 1; this.transport.sendToAttached(key, { t: 'term.data', key, seq: state.seq, data: echo } satisfies ServerMessage); }
        } else if (message.t === 'term.detach') {
          socket.attached.delete(key);
        }
      },
    });
    installFeatureHandlers(this, this.handlers); // reports, activity, settings and onboarding routes (features-handlers.ts)
  }

  // ------------------------------------------------------------------------------------------ plumbing

  private async tick(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    else await Promise.resolve();
  }

  private emit(event: Parameters<MemoryTransport['emit']>[0]): void { this.transport.emit(structuredClone(event)); }

  counts(): Counts {
    const d = this.data;
    return {
      unreadActivity: d.activity.filter((a) => !a.read).length,
      actionsNeeded: d.activity.filter((a) => a.requiresAction && a.resolvedAt === null).length,
      pendingActions: d.actions.filter((a) => a.status === 'pending').length,
      reportsAwaitingHandoff: d.reports.filter(isAwaitingHandoff).length,
      liveSessions: d.sessions.filter((s) => s.availability === 'live').length,
    };
  }

  private emitCounts(): void { this.emit({ type: 'counts', counts: this.counts() }); }

  snapshot(): StateSnapshot {
    const d = this.data;
    return {
      seq: this.transport.seq,
      system: {
        name: 'mini-summa-core', version: '0.1.0-demo', apiVersion: 1, mode: 'embedded', platform: 'win32', startedAt: nowIso(),
        nativeCapabilities: { clipboard: true, chatgptEmbedded: true, extensionBridge: false, notifications: true, openExternal: true, saveFile: true },
      },
      projects: d.projects, conversations: d.conversations, sessions: d.sessions, counts: this.counts(), settings: d.settings,
    };
  }

  /** The object the SDK-shaped `call` is built from. Every result is a copy, so callers can never alias server state. */
  call = (async (name: RouteName, input?: unknown) => {
    await this.tick();
    const handler = this.handlers[name] as ((i: unknown) => unknown) | undefined;
    if (!handler) throw new ApiError(501, 'demo_not_implemented', `The demo core does not implement ${name}.`);
    const result = await handler(input ?? {});
    return result === undefined ? undefined : structuredClone(result);
  }) as unknown as import('../../app/api').ApiClient['call'];

  // ------------------------------------------------------------------------------------------ terminals

  /** The first hook of a new run: from here on the session has a state of its own. */
  private firstHook(view: SessionView): void {
    if (view.availability !== 'live' || view.state !== 'unknown') return;
    view.state = 'waiting_for_you';
    view.stateLabel = 'Waiting for you';
    view.lastActivityAt = nowIso();
    this.touchSession(view);
  }

  private endSession(s: SessionView, reason: string, resumable: boolean): SessionView {
    s.availability = resumable ? 'resumable' : 'ended';
    s.resumable = resumable;
    s.state = 'ended'; s.stateLabel = 'Ended'; s.attention = null; s.pid = null;
    s.termination = { kind: 'observed', reason, at: nowIso() };
    s.terminal = s.terminal ? { ...s.terminal, exited: true } : null;
    this.trusting.delete(s.key);
    this.transport.sendToAttached(s.key, { t: 'term.exit', key: s.key, code: 0, signal: null, at: nowIso(), reason });
    return this.touchSession(s);
  }

  /** The person answers the trust screen in the terminal. "Yes" starts Claude (and its first hook); "No, exit" ends the session. */
  private answerTrust(session: SessionView, trust: TrustShell, data: string, state: { seq: number }): void {
    const { out, decision } = trust.feed(data);
    const send = (text: string) => { if (!text) return; state.seq += 1; this.transport.sendToAttached(session.key, { t: 'term.data', key: session.key, seq: state.seq, data: text } satisfies ServerMessage); };
    send(out);
    if (decision === 'yes') {
      this.trusting.delete(session.key);
      send(readyScreen(session.cwd ?? '~'));
      setTimeout(() => this.firstHook(session), this.firstHookDelayMs);
    } else if (decision === 'no') {
      send(declinedScreen());
      this.endSession(session, 'Claude exited at the trust prompt.', false);
    }
  }

  /**
   * What the core does when Claude replaces the conversation inside a managed terminal (/clear, /resume): the terminal (screen,
   * scrollback, attached clients) goes on under a NEW session key; the old session becomes ended history and names its successor.
   * `order` is which of the two views the window hears about first: the real core emits both in one pass, in either order.
   * Returns the new session.
   */
  replaceConversation(oldKey: SessionKey, options: { newSessionId?: string; cause?: 'clear' | 'resume'; order?: 'old-first' | 'new-first'; successorLive?: boolean } = {}): SessionView {
    const old = this.session(oldKey);
    if (old.origin !== 'managed' || old.availability !== 'live') throw new ApiError(409, 'invalid_state', 'Only a running managed terminal can go on as another session.');
    const sessionId = options.newSessionId ?? `${uid('c').slice(2)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
    const newKey = `${old.env}|${sessionId}` as SessionKey;
    const at = nowIso();
    const next: SessionView = {
      ...structuredClone(old), key: newKey, sessionId, state: 'waiting_for_you', stateLabel: 'Waiting for you', attention: null, termination: null,
      resumable: false, startedAt: at, lastActivityAt: at, isProjectDefault: old.isProjectDefault, generation: 1,
    };
    delete next.replacedBy;
    const cause = options.cause ?? 'clear';
    const reason = cause === 'clear'
      ? `The conversation was cleared with /clear. The same terminal went on as session ${sessionId.slice(0, 8)}; this session is kept as history.`
      : `Another conversation was resumed in the same terminal (/resume). The terminal went on as session ${sessionId.slice(0, 8)}; this session is kept as history.`;
    // The terminal moves with its screen and its clients; the old key keeps none.
    const terminal = this.terminals.get(oldKey);
    if (terminal) { this.terminals.delete(oldKey); this.terminals.set(newKey, terminal); }
    for (const socket of this.transport.sockets) if (socket.attached.delete(oldKey)) socket.attached.add(newKey);
    old.availability = 'resumable'; old.resumable = true; old.state = 'ended'; old.stateLabel = 'Session ended'; old.attention = null; old.pid = null;
    old.termination = { kind: 'observed', reason, at };
    old.terminal = old.terminal ? { ...old.terminal, exited: true } : null;
    old.replacedBy = newKey;
    old.isProjectDefault = false;
    this.data.sessions.push(next);
    const project = old.projectId ? this.data.projects.find((p) => p.id === old.projectId) : undefined;
    if (project && project.defaultSessionKey === oldKey) { project.defaultSessionKey = newKey; this.touchProject(project); }
    if (options.successorLive === false) { next.availability = 'resumable'; next.state = 'ended'; next.stateLabel = 'Session ended'; next.terminal = next.terminal ? { ...next.terminal, exited: true } : null; next.pid = null; }
    if ((options.order ?? 'old-first') === 'old-first') { this.touchSession(old); this.touchSession(next); } else { this.touchSession(next); this.touchSession(old); }
    return next;
  }

  // ------------------------------------------------------------------------------------------ lookups

  private project(id: string): Project {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) throw new ApiError(404, 'not_found', 'That project does not exist.');
    return p;
  }
  private conversation(id: string): Conversation {
    const c = this.data.conversations.find((x) => x.id === id);
    if (!c) throw new ApiError(404, 'not_found', 'That conversation does not exist.');
    return c;
  }
  private session(key: string): SessionView {
    const s = this.data.sessions.find((x) => x.key === key);
    if (!s) throw new ApiError(404, 'not_found', 'That session does not exist.');
    return s;
  }
  private report(id: string): Report {
    const r = this.data.reports.find((x) => x.id === id);
    if (!r) throw new ApiError(404, 'not_found', 'That report does not exist.');
    return r;
  }
  private delivery(id: string): Delivery {
    const d = this.data.deliveries.find((x) => x.id === id);
    if (!d) throw new ApiError(404, 'not_found', 'That delivery does not exist.');
    return d;
  }

  private touchProject(p: Project): Project {
    p.updatedAt = nowIso();
    this.emit({ type: 'project.upserted', project: p });
    return p;
  }
  private touchSession(s: SessionView): SessionView {
    this.emit({ type: 'session.upserted', session: s });
    this.emitCounts();
    return s;
  }
  private touchConversation(c: Conversation): Conversation {
    c.updatedAt = nowIso();
    this.emit({ type: 'conversation.upserted', conversation: c });
    return c;
  }
  private setDelivery(d: Delivery, state: DeliveryState, extra: Partial<Delivery> = {}): Delivery {
    Object.assign(d, extra, { state, stateChangedAt: nowIso(), updatedAt: nowIso() });
    const report = this.data.reports.find((r) => r.id === d.reportId);
    if (report) {
      const summary = { id: d.id, state: d.state, review: d.review, destinationTitle: d.destination?.title ?? null, updatedAt: d.updatedAt };
      report.delivery = summary;
      report.deliveries = [summary];
      this.emit({ type: 'report.upserted', report });
    }
    this.emit({ type: 'delivery.upserted', delivery: d });
    this.emitCounts();
    return d;
  }

  /** As the real core: the address of a project (or of a conversation inside one) becomes the project page, titled from the address unless the person typed a title. */
  private linkChatGptProject(input: { url: string; title?: string } | null | undefined): Project['chatgptProject'] {
    if (!input) return null;
    const parsed = parseChatGptProjectLink(input.url);
    if (!parsed.ok) throw new ApiError(400, 'invalid_chatgpt_project', parsed.message);
    return { url: parsed.link.url, scopeId: parsed.link.scopeId, title: input.title?.trim() || parsed.link.title };
  }

  private newRoot(projectId: string, position: number, input: { path: string; env?: EnvId; label?: string | null }, fallback: EnvId): ProjectRoot {
    return { id: uid(`${projectId}_root`), projectId, env: input.env ?? inferEnv(input.path, fallback), path: input.path, label: input.label ?? null, position };
  }

  // ------------------------------------------------------------------------------------------ handlers

  private readonly handlers: Handlers = {
    'system.health': () => ({ ok: true, name: 'mini-summa-core', version: '0.1.0-demo', apiVersion: 1 }),
    'system.state': async () => {
      if (this.stallSnapshot) await new Promise<never>(() => {});
      if (this.failSnapshot) throw new ApiError(500, 'demo_failure', this.failSnapshot);
      return this.snapshot();
    },
    'system.counts': () => this.counts(),

    // projects
    'projects.list': (i) => this.data.projects.filter((p) => i.query?.includeArchived === true || i.query?.includeArchived === 'true' || p.archivedAt === null),
    'projects.get': (i) => this.project(i.params.id),
    'projects.create': (i) => {
      const body = parseBody('projects.create', i.body) as { name: string; description?: string | null; githubRepo?: string | null; chatgptProject?: { url: string; title?: string } | null; defaultEnv?: EnvId; roots: { path: string; env?: EnvId; label?: string | null }[] };
      const id = uid('prj');
      const fallback: EnvId = body.defaultEnv ?? 'win';
      const roots = body.roots.map((r, n) => this.newRoot(id, n, r, fallback));
      const project: Project = {
        id, name: body.name, description: body.description ?? null, githubRepo: body.githubRepo ?? null, chatgptProject: this.linkChatGptProject(body.chatgptProject), roots,
        defaultEnv: body.defaultEnv ?? roots[0]?.env ?? 'win', preferredConversationId: null, defaultSessionKey: null,
        notificationPrefs: structuredClone(this.data.settings.notifications.defaults), sortOrder: this.data.projects.length, archivedAt: null, createdAt: nowIso(), updatedAt: nowIso(),
      };
      this.data.projects.push(project);
      return this.touchProject(project);
    },
    'projects.update': (i) => {
      const body = parseBody('projects.update', i.body) as { name?: string; description?: string | null; githubRepo?: string | null; chatgptProject?: { url: string; title?: string } | null; defaultEnv?: EnvId; notificationPrefs?: Partial<Project['notificationPrefs']>; archived?: boolean };
      const p = this.project(i.params.id);
      if (body.name !== undefined) p.name = body.name;
      if (body.description !== undefined) p.description = body.description;
      if (body.githubRepo !== undefined) p.githubRepo = body.githubRepo;
      if (body.chatgptProject !== undefined) p.chatgptProject = this.linkChatGptProject(body.chatgptProject);
      if (body.defaultEnv !== undefined) p.defaultEnv = body.defaultEnv;
      if (body.notificationPrefs) p.notificationPrefs = { ...p.notificationPrefs, ...body.notificationPrefs };
      if (body.archived !== undefined) p.archivedAt = body.archived ? nowIso() : null;
      if (body.name !== undefined) for (const s of this.data.sessions) if (s.projectId === p.id) s.projectName = p.name;
      return this.touchProject(p);
    },
    'projects.remove': async (i) => {
      const p = this.project(i.params.id);
      // As the real core: a project with running Claude terminals is refused until the caller says to end them.
      const running = this.data.sessions.filter((s) => s.projectId === p.id && s.origin === 'managed' && s.availability === 'live');
      if (running.length > 0) {
        if (!i.query?.stopSessions) {
          const n = running.length;
          throw new ApiError(409, 'sessions_running', `This project has ${n} running Claude terminal${n === 1 ? '' : 's'}. Stop ${n === 1 ? 'it' : 'them'} first, or confirm that Mini-Summa should stop ${n === 1 ? 'it' : 'them'} when removing the project.`, { sessions: running.map((s) => s.key) });
        }
        for (const s of running) this.endSession(s, 'You stopped the session.', true);
      }
      if (i.query?.mode === 'delete') {
        const d = this.data;
        d.projects = d.projects.filter((x) => x.id !== p.id);
        d.conversations = d.conversations.filter((c) => c.projectId !== p.id);
        d.reports = d.reports.filter((r) => r.projectId !== p.id);
        d.deliveries = d.deliveries.filter((x) => x.projectId !== p.id);
        d.activity = d.activity.filter((a) => a.projectId !== p.id);
        d.actions = d.actions.filter((a) => a.projectId !== p.id);
        for (const s of d.sessions) if (s.projectId === p.id) { s.projectId = null; s.projectName = null; s.projectResolution = 'unregistered_directory'; }
        this.emit({ type: 'project.removed', id: p.id });
        for (const s of d.sessions.filter((x) => x.projectId === null)) this.emit({ type: 'session.upserted', session: s });
        this.emitCounts();
      } else {
        p.archivedAt = nowIso();
        this.touchProject(p);
      }
      return ok;
    },
    'projects.reorder': (i) => {
      const { ids } = parseBody('projects.reorder', i.body) as { ids: string[] };
      ids.forEach((id, n) => { const p = this.data.projects.find((x) => x.id === id); if (p) { p.sortOrder = n; this.touchProject(p); } });
      return ok;
    },
    'projects.addRoot': (i) => {
      const body = parseBody('projects.addRoot', i.body) as { path: string; env?: EnvId; label?: string | null };
      const p = this.project(i.params.id);
      p.roots.push(this.newRoot(p.id, p.roots.length, body, p.defaultEnv));
      return this.touchProject(p);
    },
    'projects.removeRoot': (i) => {
      const p = this.project(i.params.id);
      p.roots = p.roots.filter((r) => r.id !== i.params.rootId).map((r, n) => ({ ...r, position: n }));
      return this.touchProject(p);
    },

    // conversations
    'conversations.list': (i) => this.data.conversations.filter((c) => c.projectId === i.params.id).sort((a, b) => a.position - b.position),
    'conversations.add': (i) => {
      const body = parseBody('conversations.add', i.body) as { url: string; title?: string; note?: string | null; makePreferred?: boolean };
      const p = this.project(i.params.id);
      const parsed = parseChatGptUrl(body.url);
      if (!parsed.ok) throw new ApiError(400, 'invalid_url', parsed.message);
      const siblings = this.data.conversations.filter((c) => c.projectId === p.id);
      const c: Conversation = {
        id: uid('cnv'), projectId: p.id, title: body.title?.trim() || suggestConversationTitle(parsed.info), url: parsed.info.url, originalUrl: parsed.info.originalUrl,
        kind: parsed.info.kind, chatgptConversationId: parsed.info.chatgptConversationId, verification: 'unverified', verifiedAt: null, verifiedTitle: null,
        note: body.note ?? null, position: siblings.length, createdAt: nowIso(), updatedAt: nowIso(),
      };
      this.data.conversations.push(c);
      this.touchConversation(c);
      if (siblings.length === 0 || body.makePreferred) { p.preferredConversationId = c.id; this.touchProject(p); }
      return c;
    },
    'conversations.update': (i) => {
      const body = parseBody('conversations.update', i.body) as { url?: string; title?: string; note?: string | null };
      const c = this.conversation(i.params.id);
      if (body.url !== undefined && body.url !== c.url) {
        const parsed = parseChatGptUrl(body.url);
        if (!parsed.ok) throw new ApiError(400, 'invalid_url', parsed.message);
        Object.assign(c, { url: parsed.info.url, originalUrl: parsed.info.originalUrl, kind: parsed.info.kind, chatgptConversationId: parsed.info.chatgptConversationId, verification: 'unverified', verifiedAt: null, verifiedTitle: null });
      }
      if (body.title !== undefined) c.title = body.title;
      if (body.note !== undefined) c.note = body.note;
      return this.touchConversation(c);
    },
    'conversations.remove': (i) => {
      const c = this.conversation(i.params.id);
      const p = this.project(c.projectId);
      this.data.conversations = this.data.conversations.filter((x) => x.id !== c.id);
      this.data.conversations.filter((x) => x.projectId === p.id).sort((a, b) => a.position - b.position).forEach((x, n) => { x.position = n; });
      this.emit({ type: 'conversation.removed', id: c.id, projectId: p.id });
      if (p.preferredConversationId === c.id) {
        p.preferredConversationId = this.data.conversations.filter((x) => x.projectId === p.id).sort((a, b) => a.position - b.position)[0]?.id ?? null;
        this.touchProject(p);
      }
      return ok;
    },
    'conversations.setPreferred': (i) => {
      const { conversationId } = parseBody('conversations.setPreferred', i.body) as { conversationId: string | null };
      const p = this.project(i.params.id);
      if (conversationId !== null && this.conversation(conversationId).projectId !== p.id) throw new ApiError(409, 'wrong_project', 'That conversation belongs to another project.');
      p.preferredConversationId = conversationId;
      return this.touchProject(p);
    },
    'conversations.open': (i): ChatGptOpenResult => {
      const c = this.conversation(i.params.id);
      this.onOpen?.(c.url);
      return { ok: true, mode: 'embedded', opened: true, focused: true, verified: null, finalUrl: c.url, title: null, note: null };
    },
    'conversations.verify': async (i) => {
      const c = this.conversation(i.params.id);
      await new Promise((r) => setTimeout(r, this.latencyMs || 250));
      const specific = c.chatgptConversationId !== null;
      c.verification = specific ? (c.title.toLowerCase().includes('market') ? 'login_required' : 'verified') : 'unverified';
      c.verifiedAt = specific ? nowIso() : null;
      c.verifiedTitle = c.verification === 'verified' ? c.title : null;
      return this.touchConversation(c);
    },

    // sessions
    'sessions.list': (i) => this.data.sessions.filter((s) => (!i.query?.projectId || s.projectId === i.query.projectId)),
    'sessions.get': (i) => this.session(i.params.key),
    'sessions.start': (i) => {
      const body = parseBody('sessions.start', i.body) as { mode: 'new' | 'resume'; resumeKey?: SessionKey; env?: EnvId; rootId?: string; name?: string };
      const p = this.project(i.params.id);
      let previous: SessionView | undefined;
      if (body.mode === 'resume') {
        previous = this.session(body.resumeKey ?? '');
        if (!previous.resumable || previous.availability === 'live') throw new ApiError(409, 'not_resumable', 'That session cannot be resumed right now.');
      }
      const chosen = body.rootId ? p.roots.find((r) => r.id === body.rootId) : p.roots.find((r) => r.env === previous?.env) ?? p.roots[0];
      if (!chosen) throw new ApiError(409, 'no_folder', 'Add a repository folder to this project first.');
      const env = body.env ?? chosen.env;
      const sessionId = crypto.randomUUID();
      const view: SessionView = {
        key: `${env}|${sessionId}` as SessionKey, env, sessionId, origin: 'managed', availability: 'live', termination: null, resumable: false,
        projectId: p.id, projectName: p.name, projectResolution: 'managed', cwd: chosen.path, name: body.name ?? null, state: 'unknown', stateLabel: 'Starting', stateEvidence: 'managed:pty',
        generation: 1, pid: 5000 + Math.floor(Math.random() * 900), startedAt: nowIso(), lastActivityAt: nowIso(), attention: null, unresolvedOrdering: 0,
        terminal: { cols: 120, rows: 32, exited: false }, isProjectDefault: false,
        remoteControl: { state: 'not_enabled', hint: 'Type /remote-control in this session to control it from the Claude app or the web.' },
      };
      this.data.sessions.push(view);
      this.touchSession(view);
      if (this.trustPrompt && body.mode === 'new') this.trusting.set(view.key, new TrustShell(chosen.path));
      else setTimeout(() => this.firstHook(view), this.firstHookDelayMs);
      if (!p.defaultSessionKey) { p.defaultSessionKey = view.key; view.isProjectDefault = true; this.touchProject(p); }
      return view;
    },
    'sessions.stop': (i) => {
      const s = this.session(i.params.key);
      if (s.origin !== 'managed') throw new ApiError(409, 'not_managed', 'Only sessions started by Mini-Summa can be stopped here.');
      return this.endSession(s, 'You stopped the session.', true);
    },
    'sessions.bind': (i) => {
      const { projectId } = parseBody('sessions.bind', i.body) as { projectId: string | null };
      const s = this.session(i.params.key);
      const p = projectId ? this.project(projectId) : null;
      s.projectId = p?.id ?? null; s.projectName = p?.name ?? null; s.projectResolution = p ? 'manual' : 'unregistered_directory';
      return this.touchSession(s);
    },
    'sessions.setDefault': (i) => {
      const { isDefault } = parseBody('sessions.setDefault', i.body) as { isDefault: boolean };
      const s = this.session(i.params.key);
      const p = this.project(s.projectId ?? '');
      for (const other of this.data.sessions) if (other.projectId === p.id && other.isProjectDefault) { other.isProjectDefault = false; this.emit({ type: 'session.upserted', session: other }); }
      s.isProjectDefault = isDefault;
      p.defaultSessionKey = isDefault ? s.key : null;
      this.touchSession(s);
      return this.touchProject(p);
    },
    'sessions.refresh': () => ({ ran: ['win', 'wsl:Ubuntu'], errors: [] }),

    // reports and deliveries
    'reports.list': (i) => ({
      items: this.data.reports.filter((r) => (!i.query?.projectId || r.projectId === i.query.projectId) && (i.query?.unread === undefined || String(i.query.unread) !== 'true' || !r.read)),
      nextBefore: null,
    }),
    'reports.get': (i) => this.report(i.params.id),
    'reports.markRead': (i) => {
      const r = this.report(i.params.id);
      r.read = true;
      this.emit({ type: 'report.upserted', report: r });
      return r;
    },
    'candidates.list': () => [],
    'deliveries.list': (i) => this.data.deliveries.filter((d) => (!i.query?.projectId || d.projectId === i.query.projectId) && (!i.query?.reportId || d.reportId === i.query.reportId)),
    'deliveries.get': (i): DeliveryDetail => ({ ...this.delivery(i.params.id), events: [] }),
    'deliveries.create': (i) => {
      const body = parseBody('deliveries.create', i.body) as { conversationId?: string; includeReviewRequest?: boolean };
      const r = this.report(i.params.id);
      const p = this.project(r.projectId ?? '');
      const conv = body.conversationId ? this.conversation(body.conversationId) : this.data.conversations.find((c) => c.id === p.preferredConversationId) ?? null;
      const d: Delivery = {
        id: uid('dlv'), reportId: r.id, projectId: r.projectId, projectName: r.projectName, sessionKey: r.sessionKey, taskTitle: r.taskTitle,
        state: conv ? (conv.verification === 'verified' ? 'ready_for_handoff' : 'destination_unverified') : 'destination_missing', destination: conv
          ? { conversationId: conv.id, url: conv.url, title: conv.title, chatgptConversationId: conv.chatgptConversationId, resolvedFrom: body.conversationId ? 'user_selected' : 'project_preferred', verificationAtFreeze: conv.verification, frozenAt: nowIso() }
          : null,
        review: 'none', includeReviewRequest: body.includeReviewRequest ?? true, messageSha256: null, messageChars: null, parts: [], followUpDraft: null, attempts: 0, lastError: null,
        stateChangedAt: nowIso(), createdAt: nowIso(), updatedAt: nowIso(),
      };
      this.data.deliveries.push(d);
      return this.setDelivery(d, d.state);
    },
    'deliveries.prepare': (i) => {
      const d = this.delivery(i.params.id);
      const r = this.report(d.reportId);
      const message = buildReportMessage({
        reportId: r.id, projectName: r.projectName ?? 'Unassigned', taskTitle: r.taskTitle, sessionRef: `${r.sessionId.slice(0, 8)}, managed, ${r.env}`, declaredStatus: r.declaredStatus,
        capturedAt: r.capturedAt, body: r.body, reviewRequest: d.includeReviewRequest ? this.data.settings.review.requestTemplate : null, includeSessionRef: this.data.settings.review.includeSessionRef,
      });
      const parts = splitMessage(message, r.id, this.data.settings.review.maxPartChars);
      d.messageChars = message.length;
      d.parts = parts.map((part) => ({ index: part.index, total: part.total, chars: part.text.length, sha256: `${part.index}`.padEnd(64, '0'), copiedAt: null }));
      this.setDelivery(d, d.state);
      return { delivery: d, message, partCount: parts.length };
    },
    'deliveries.copy': (i) => {
      const d = this.delivery(i.params.id);
      this.setDelivery(d, 'copied');
      return { delivery: d, part: 1, partCount: Math.max(1, d.parts.length), clipboard: 'client', text: null };
    },
    'deliveries.open': (i) => {
      const d = this.delivery(i.params.id);
      if (d.destination) this.onOpen?.(d.destination.url);
      return { delivery: d, open: { ok: true, mode: 'embedded', opened: true, focused: true, verified: null, finalUrl: d.destination?.url ?? null, title: null, note: null } };
    },
    'deliveries.handoff': (i) => {
      const d = this.delivery(i.params.id);
      if (d.destination) this.onOpen?.(d.destination.url);
      this.setDelivery(d, 'awaiting_user_send');
      return { delivery: d, part: 1, partCount: Math.max(1, d.parts.length), clipboard: 'client', text: null, open: { ok: true, mode: 'embedded', opened: true, focused: true, verified: null, finalUrl: d.destination?.url ?? null, title: null, note: null } };
    },
    'deliveries.confirmSent': (i) => this.setDelivery(this.delivery(i.params.id), 'user_confirmed_sent', { review: 'requested' }),
    'deliveries.markUncertain': (i) => this.setDelivery(this.delivery(i.params.id), 'delivery_uncertain'),
    'deliveries.discard': (i) => this.setDelivery(this.delivery(i.params.id), 'user_discarded'),
    'deliveries.reopen': (i) => this.setDelivery(this.delivery(i.params.id), this.delivery(i.params.id).destination ? 'ready_for_handoff' : 'destination_missing'),
    'deliveries.setDestination': (i) => {
      const { conversationId } = parseBody('deliveries.setDestination', i.body) as { conversationId: string };
      const d = this.delivery(i.params.id);
      const c = this.conversation(conversationId);
      return this.setDelivery(d, c.verification === 'verified' ? 'ready_for_handoff' : 'destination_unverified', {
        destination: { conversationId: c.id, url: c.url, title: c.title, chatgptConversationId: c.chatgptConversationId, resolvedFrom: 'user_selected', verificationAtFreeze: c.verification, frozenAt: nowIso() },
      });
    },
    'deliveries.setReview': (i) => {
      const body = parseBody('deliveries.setReview', i.body) as { review: Delivery['review']; followUpDraft?: string | null };
      const d = this.delivery(i.params.id);
      return this.setDelivery(d, d.state, { review: body.review, followUpDraft: body.followUpDraft === undefined ? d.followUpDraft : body.followUpDraft });
    },
    'deliveries.saveFile': (i) => ({ delivery: this.delivery(i.params.id), path: null }),

    // actions
    'actions.list': (i) => this.data.actions.filter((a) => (i.query?.status === 'all' || a.status === 'pending') && (!i.query?.projectId || a.projectId === i.query.projectId)),
    'actions.approve': (i) => {
      const a = this.data.actions.find((x) => x.id === i.params.id);
      if (!a) throw new ApiError(404, 'not_found', 'That action does not exist.');
      Object.assign(a, { status: 'executed', decidedAt: nowIso(), executedAt: nowIso(), decidedBy: { kind: 'desktop' } });
      const s = this.data.sessions.find((x) => x.key === a.sessionKey);
      if (s) { s.state = 'working'; s.stateLabel = 'Working'; s.attention = null; this.touchSession(s); }
      for (const act of this.data.activity) if (act.sessionKey === a.sessionKey && act.requiresAction) { act.resolvedAt = nowIso(); this.emit({ type: 'activity.updated', activity: act }); }
      this.emit({ type: 'action.upserted', action: a });
      this.emitCounts();
      return a;
    },
    'actions.reject': (i) => {
      const a = this.data.actions.find((x) => x.id === i.params.id);
      if (!a) throw new ApiError(404, 'not_found', 'That action does not exist.');
      Object.assign(a, { status: 'rejected', decidedAt: nowIso(), decidedBy: { kind: 'desktop' } });
      this.emit({ type: 'action.upserted', action: a });
      this.emitCounts();
      return a;
    },

    // activity and notifications
    'activity.list': (i) => ({ items: this.data.activity.filter((a) => (!i.query?.projectId || a.projectId === i.query.projectId) && (String(i.query?.unread) !== 'true' || !a.read)), nextBefore: null }),
    'activity.markRead': (i) => {
      const body = parseBody('activity.markRead', i.body) as { ids?: string[]; all?: boolean; projectId?: string };
      const touched: ActivityEvent[] = this.data.activity.filter((a) => !a.read && (body.all || body.ids?.includes(a.id) || (body.projectId && a.projectId === body.projectId)));
      for (const a of touched) a.read = true;
      const counts = this.counts();
      this.emit({ type: 'activity.read', ids: touched.map((a) => a.id), counts });
      return counts;
    },
    'notifications.list': () => this.data.notifications,

    // settings, environments, hooks
    'settings.get': () => this.data.settings,
    'settings.update': (i) => {
      const patch = parseBody('settings.update', i.body);
      this.data.settings = mergeSettings(this.data.settings, patch);
      this.emit({ type: 'settings.changed', settings: this.data.settings });
      return this.data.settings;
    },
    'environments.list': () => this.data.environments,
    'hooks.list': () => this.data.hooks,
    'hooks.plan': (i) => {
      const body = parseBody('hooks.plan', i.body) as { env: EnvId; action: 'install' | 'uninstall' };
      const status = this.data.hooks.find((h) => h.env === body.env) ?? this.data.hooks[0];
      return {
        env: body.env, settingsPath: status.settingsPath, planHash: 'demo-plan-hash-0000000000', action: body.action, before: '{\n}', after: '{\n  "hooks": { "Stop": [] }\n}',
        unifiedDiff: '--- settings.json\n+++ settings.json\n@@\n+  "hooks": { "Stop": [] }', backupPath: `${status.settingsPath}.bak`, warnings: [], status,
      };
    },
    'hooks.apply': (i) => {
      const body = parseBody('hooks.apply', i.body) as { env: EnvId; action: 'install' | 'uninstall' };
      const status = this.data.hooks.find((h) => h.env === body.env);
      if (!status) throw new ApiError(404, 'not_found', 'Unknown environment.');
      status.installed = body.action === 'install';
      status.missingEvents = status.installed ? [] : ['SessionStart', 'Stop', 'SessionEnd'];
      this.emit({ type: 'hooks.changed', env: status.env, status });
      return status;
    },

    // devices and pairing
    'devices.list': () => this.data.devices,
    'devices.self': () => this.data.devices[0],
    'devices.update': (i) => {
      const body = parseBody('devices.update', i.body) as { name?: string; trusted?: boolean };
      const d = this.data.devices.find((x) => x.id === i.params.id);
      if (!d) throw new ApiError(404, 'not_found', 'That device does not exist.');
      Object.assign(d, body);
      this.emit({ type: 'device.upserted', device: d });
      return d;
    },
    'devices.revoke': (i) => {
      this.data.devices = this.data.devices.filter((d) => d.id !== i.params.id);
      this.emit({ type: 'device.removed', id: i.params.id });
      return ok;
    },
    'pairing.createOffer': () => {
      const offer = { id: uid('ofr'), code: 'DEMO-CODE-0000', expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), scopes: ['read', 'notify'] as ('read' | 'notify')[], urls: ['http://127.0.0.1:0'] };
      return { ...offer, qrPayload: encodePairingPayload({ version: 1, code: offer.code, offerId: offer.id, urls: offer.urls, name: 'Mini-Summa demo' }) };
    },
    'push.test': () => ({ sent: 0, failed: 0, skipped: 'Push is not configured in the demo.' }),
    'tailscale.status': (): TailscaleStatus => ({
      installed: false, running: false, loggedIn: false, backendState: null, hostName: null, dnsName: null, tailnet: null, tailscaleIps: [],
      serve: { configured: false, url: null, target: null, funnelDetected: false }, checkedAt: nowIso(), problem: 'Tailscale is not installed on this PC.',
    }),
    'data.usage': () => ({ dataDir: 'C:\\Users\\dev\\AppData\\Roaming\\Mini-Summa', databaseBytes: 1_480_000, rawEvents: 2410, activity: this.data.activity.length, reports: this.data.reports.length, deliveries: this.data.deliveries.length, notifications: this.data.notifications.length, oldestRawEventAt: nowIso() }),
    'data.prune': (i) => ({ dryRun: Boolean((i.body as { dryRun?: boolean } | undefined)?.dryRun), removed: { rawEvents: 0, activity: 0, notifications: 0, reports: 0, deliveries: 0 } }),
  };
}

const IDS_FOR_REPLAY = { gmWorking: IDS.s.gmWorking, gmPermission: IDS.s.gmPermission, atlasIdle: IDS.s.atlasIdle, dashFailed: IDS.s.dashFailed };
