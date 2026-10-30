// Demo-core handlers for the reports, activity, settings and onboarding features.
//
// The base demo server (server.ts) answers most routes in a simplified way. These handlers replace the ones the feature
// views depend on with behaviour that follows the real core closely enough to test against: the delivery state machine
// refuses what the real one refuses (with the same error codes), parts are split by the real splitter, a hooks plan is a
// real diff with a hash that goes stale, a typed prompt re-checks its target, and so on.
//
// server.ts registers all of this with one line in its constructor. Per-server state lives in a WeakMap keyed by the
// seed data, so DemoData and seed.ts stay untouched.
import {
  ApiError, buildReportMessage, encodePairingPayload, envLabel, mergeSettings, shortSessionId, splitMessage,
} from '@minisumma/shared';
import type {
  ActivityEvent, ActorRef, ChatGptOpenResult, Conversation, Delivery, DeliveryDetail, DeliveryEvent, DeliveryEventType, DeliveryPartInfo,
  DeliveryResolution, DeliveryState, Device, EnvId, HookPlan, HookStatus, PendingAction, Project, Report, ReportCandidate, ReportSummary, ReviewState,
  RouteInput, RouteName, RouteOutput, Scope, SessionView, TailscaleStatus,
} from '@minisumma/shared';
import type { DemoData } from './seed';
import type { DemoServer } from './server';

type Handler<K extends RouteName> = (input: RouteInput<K>) => RouteOutput<K> | Promise<RouteOutput<K>>;
type HandlerMap = { [K in RouteName]?: Handler<K> };

const DESKTOP: ActorRef = { kind: 'desktop' };
const nowIso = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------------------------------------------
// State the base seed has no room for

export interface FeatureDemoState {
  candidates: ReportCandidate[];
  events: Map<string, DeliveryEvent[]>;
  /** What copy and handoff report as the clipboard path. The real core says 'native' inside the desktop app. */
  clipboard: 'client' | 'native';
  /** What opening a conversation reports. */
  open: (url: string) => ChatGptOpenResult;
  /** Where "Save as file" writes. null means the person cancelled the save dialog. */
  savePath: string | null;
  /** The next call to a route throws this once. */
  failNext: Map<RouteName, ApiError>;
  /** When set, a typed prompt reaches the terminal check but fails with this text, as a real failure would. */
  promptFailure: string | null;
  /** settings.json text per environment, as the hooks installer would read it. */
  hookFiles: Map<EnvId, string>;
  /** The settings file changes behind the installer's back right before the next apply for this environment. */
  hookDrift: Set<EnvId>;
  offers: Map<string, { scopes: Scope[]; kind: 'phone' | 'extension'; expiresAt: string }>;
  tailscale: TailscaleStatus;
  /** What enabling Serve reports when it does not work: a problem text, or null for success. */
  serveProblem: string | null;
  /** How many raw hook events the retention rule would remove. */
  prunableRawEvents: number;
  /** Fake clock for offers and prune cut-offs. Default: the real one. */
  now: () => number;
  counter: number;
}

const states = new WeakMap<DemoData, FeatureDemoState>();

const RAW_HOOKS_SAMPLE = {
  win: {
    model: 'sonnet',
    permissions: { allow: ['Bash(npm test:*)', 'Bash(git status)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node C:\\Users\\dev\\tools\\audit-bash.mjs' }] }] },
  },
  other: { permissions: { allow: ['Bash(git status)'] } },
};

function hookCommand(env: EnvId): string {
  return env === 'win'
    ? 'node "C:\\Users\\dev\\AppData\\Roaming\\Mini-Summa\\hook\\capture.mjs" --handler ms-user'
    : 'node /mnt/c/Users/dev/AppData/Roaming/Mini-Summa/hook/capture.mjs --handler ms-user';
}

const HOOK_EVENTS = ['SessionStart', 'Stop', 'SessionEnd', 'PermissionRequest', 'Notification'];

function withHooks(root: Record<string, unknown>, env: EnvId): Record<string, unknown> {
  const hooks = { ...((root.hooks as Record<string, unknown[]> | undefined) ?? {}) };
  for (const e of HOOK_EVENTS) {
    const list = ((hooks[e] as { hooks?: { command?: string }[] }[] | undefined) ?? []).filter((g) => !g.hooks?.some((h) => /--handler ms-user/.test(h.command ?? '')));
    hooks[e] = [...list, { hooks: [{ type: 'command', command: hookCommand(env), ...(env === 'win' ? { shell: 'powershell' } : {}) }] }];
  }
  return { ...root, hooks };
}

function withoutHooks(root: Record<string, unknown>): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries((root.hooks as Record<string, { hooks?: { command?: string }[] }[]> | undefined) ?? {})) {
    const kept = groups.filter((g) => !g.hooks?.some((h) => /--handler ms-user/.test(h.command ?? '')));
    if (kept.length) hooks[event] = kept;
  }
  const { hooks: _gone, ...rest } = root;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function defaultTailscale(): TailscaleStatus {
  return {
    installed: true, running: true, loggedIn: true, backendState: 'Running', hostName: 'dev-pc', dnsName: 'dev-pc.tail1a2b3.ts.net', tailnet: 'dev@example.com',
    tailscaleIps: ['100.101.102.103'], serve: { configured: false, url: null, target: null, funnelDetected: false }, checkedAt: nowIso(), problem: null,
  };
}

export function featureState(data: DemoData): FeatureDemoState {
  let st = states.get(data);
  if (!st) {
    const files = new Map<EnvId, string>();
    for (const h of data.hooks) {
      const base = h.env === 'win' ? RAW_HOOKS_SAMPLE.win : RAW_HOOKS_SAMPLE.other;
      files.set(h.env, pretty(h.installed ? withHooks(base as Record<string, unknown>, h.env) : base));
    }
    st = {
      candidates: [], events: new Map(), clipboard: 'client',
      open: (url) => ({ ok: true, mode: 'embedded', opened: true, focused: true, verified: null, finalUrl: url, title: null, note: null }),
      savePath: 'C:\\Users\\dev\\Documents\\report.md', failNext: new Map(), promptFailure: null, hookFiles: files, hookDrift: new Set(), offers: new Map(),
      tailscale: defaultTailscale(), serveProblem: null, prunableRawEvents: 612, now: Date.now, counter: 0,
    };
    states.set(data, st);
  }
  return st;
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

function hashHex(text: string): string {
  let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const part = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  const one = `${part(h2)}${part(h1)}`;
  return `${one}${one.split('').reverse().join('')}${one}${one.split('').reverse().join('')}`;
}

// A plain line diff in unified format with three lines of context.
function unifiedDiff(before: string, after: string, path: string, created: boolean): string {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const n = a.length; const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ t: '-', s: a[i] }); i++; }
    else { ops.push({ t: '+', s: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: '-', s: a[i++] });
  while (j < m) ops.push({ t: '+', s: b[j++] });

  const context = 3;
  const changed = ops.map((o, k) => (o.t === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) return '';
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const from = Math.max(0, k - context); const to = Math.min(ops.length - 1, k + context);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to); else hunks.push([from, to]);
  }
  const out = [created ? '--- /dev/null' : `--- ${path}`, `+++ ${path}`];
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, to + 1);
    const oldStart = ops.slice(0, from).filter((o) => o.t !== '+').length + 1;
    const newStart = ops.slice(0, from).filter((o) => o.t !== '-').length + 1;
    const oldCount = slice.filter((o) => o.t !== '+').length;
    const newCount = slice.filter((o) => o.t !== '-').length;
    out.push(`@@ -${oldCount === 0 ? 0 : oldStart},${oldCount} +${newCount === 0 ? 0 : newStart},${newCount} @@`);
    for (const o of slice) out.push(`${o.t}${o.s}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The state machine of a delivery, as the real core enforces it

const ALL_STATES: DeliveryState[] = [
  'report_captured', 'destination_missing', 'destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send',
  'user_confirmed_sent', 'delivery_uncertain', 'user_discarded',
];
const CLOSED: DeliveryState[] = ['user_confirmed_sent', 'user_discarded'];
const COPY_FROM: DeliveryState[] = ['destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send'];
const OPEN_FROM: DeliveryState[] = [...COPY_FROM, 'delivery_uncertain', 'user_confirmed_sent'];
const CONFIRM_FROM: DeliveryState[] = [...COPY_FROM, 'delivery_uncertain'];
const UNCERTAIN_FROM: DeliveryState[] = ['copied', 'awaiting_user_send', 'user_confirmed_sent'];
const REOPEN_FROM: DeliveryState[] = ['user_discarded', 'delivery_uncertain'];
const DISCARD_FROM: DeliveryState[] = ALL_STATES.filter((s) => !CLOSED.includes(s));
const DESTINATION_FROM: DeliveryState[] = ['destination_missing', 'destination_unverified', 'ready_for_handoff', 'copied', 'awaiting_user_send', 'delivery_uncertain'];

const REVIEW_ALLOWED: Record<ReviewState, ReviewState[]> = {
  none: ['closed'],
  requested: ['received', 'follow_up_drafted', 'closed'],
  received: ['follow_up_drafted', 'closed'],
  follow_up_drafted: ['follow_up_drafted', 'closed'],
  follow_up_sent: ['closed'],
  closed: ['received', 'closed'],
};

const STATE_PHRASE: Record<DeliveryState, string> = {
  report_captured: 'still being set up', destination_missing: 'missing a destination', destination_unverified: 'waiting with a destination that is not verified',
  ready_for_handoff: 'ready to hand off', copied: 'copied', awaiting_user_send: 'waiting for you to send it', user_confirmed_sent: 'marked as sent',
  delivery_uncertain: 'marked as uncertain', user_discarded: 'discarded',
};

const stateForVerification = (v: Conversation['verification']): DeliveryState => (v === 'verified' ? 'ready_for_handoff' : 'destination_unverified');

// ---------------------------------------------------------------------------------------------------------------

/** The long-lived pieces a handler needs from the server, all public. */
export function installFeatureHandlers(server: DemoServer, handlers: object): void {
  Object.assign(handlers, createFeatureHandlers(server));
  // A test or a screenshot script can make the next call to any route fail once (featureState(...).failNext).
  const table = handlers as Record<string, (input: unknown) => unknown>;
  for (const [name, fn] of Object.entries(table)) {
    table[name] = (input: unknown) => {
      const failures = featureState(server.data).failNext;
      const failure = failures.get(name as RouteName);
      if (failure) { failures.delete(name as RouteName); throw failure; }
      return fn(input);
    };
  }
}

export function createFeatureHandlers(server: DemoServer): HandlerMap {
  const data = (): DemoData => server.data;
  const st = (): FeatureDemoState => featureState(server.data);
  const emit = (event: Parameters<DemoServer['transport']['emit']>[0]): void => { server.transport.emit(structuredClone(event)); };
  const emitCounts = (): void => emit({ type: 'counts', counts: server.counts() });
  const next = (prefix: string): string => `${prefix}_${++st().counter}`;

  const notFound = (what: string): ApiError => new ApiError(404, 'not_found', `${what} was not found.`);
  const reportOf = (id: string): Report => data().reports.find((r) => r.id === id) ?? (() => { throw notFound('That report'); })();
  const deliveryOf = (id: string): Delivery => data().deliveries.find((d) => d.id === id) ?? (() => { throw notFound('That delivery'); })();
  const conversationOf = (id: string): Conversation => data().conversations.find((c) => c.id === id) ?? (() => { throw notFound('That conversation'); })();
  const projectOf = (id: string | null): Project | null => (id ? data().projects.find((p) => p.id === id) ?? null : null);
  const sessionOf = (key: string): SessionView | undefined => data().sessions.find((s) => s.key === key);

  // Failures are injected for every route by installFeatureHandlers; this only keeps the table below readable.
  const guarded = <K extends RouteName>(_name: K, fn: Handler<K>): Handler<K> => fn;

  // ----- deliveries -----

  function addEvent(d: Delivery, type: DeliveryEventType, e: { from?: DeliveryState | null; to?: DeliveryState | null; actor?: ActorRef; detail?: Record<string, unknown>; at?: string }): void {
    const list = st().events.get(d.id) ?? [];
    list.push({ id: next('evt'), deliveryId: d.id, at: e.at ?? nowIso(), type, from: e.from ?? d.state, to: e.to ?? d.state, actor: e.actor ?? DESKTOP, detail: e.detail ?? {} });
    st().events.set(d.id, list);
  }

  /** Writes the change, refreshes the report's embedded summary and tells every client, in the order the real core does. */
  function commit(d: Delivery, patch: Partial<Delivery>): Delivery {
    const stateChanged = patch.state !== undefined && patch.state !== d.state;
    Object.assign(d, patch, { updatedAt: nowIso() });
    if (stateChanged) d.stateChangedAt = d.updatedAt;
    const report = data().reports.find((r) => r.id === d.reportId);
    if (report) {
      const latest = data().deliveries.filter((x) => x.reportId === report.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? d;
      const summary = { id: latest.id, state: latest.state, review: latest.review, destinationTitle: latest.destination?.title ?? null, updatedAt: latest.updatedAt };
      report.delivery = summary;
      report.deliveries = data().deliveries.filter((x) => x.reportId === report.id).map((x) => ({ id: x.id, state: x.state, review: x.review, destinationTitle: x.destination?.title ?? null, updatedAt: x.updatedAt }));
      emit({ type: 'report.upserted', report });
    }
    emit({ type: 'delivery.upserted', delivery: d });
    emitCounts();
    return d;
  }

  function guard(d: Delivery, op: { verb: string; allowed: DeliveryState[]; needsDestination?: boolean }): void {
    const missing = () => new ApiError(409, 'destination_missing', 'This report has no ChatGPT conversation to go to yet. Choose a conversation for it first.');
    if (op.allowed.includes(d.state)) {
      if (op.needsDestination && d.destination === null) throw missing();
      return;
    }
    if (CLOSED.includes(d.state)) {
      throw new ApiError(409, 'delivery_closed', d.state === 'user_discarded'
        ? `This handoff was discarded, so it cannot be ${op.verb}. Reopen it first if you want to continue.`
        : `This handoff is already marked as sent, so it cannot be ${op.verb}.`);
    }
    if (op.needsDestination && d.destination === null) throw missing();
    const hint = d.state === 'delivery_uncertain' ? ' Reopen it to try again, or confirm that it was sent.' : d.state === 'destination_missing' ? ' Choose a conversation for it first.' : '';
    throw new ApiError(409, 'invalid_state', `This handoff is ${STATE_PHRASE[d.state]}, so it cannot be ${op.verb} now.${hint}`);
  }

  const settings = () => data().settings;

  function messageFor(d: Delivery): { message: string; parts: ReturnType<typeof splitMessage> } {
    const r = reportOf(d.reportId);
    const view = sessionOf(d.sessionKey);
    const s = settings();
    const message = buildReportMessage({
      reportId: r.id, projectName: d.projectName ?? 'No project', taskTitle: d.taskTitle,
      sessionRef: [shortSessionId(d.sessionKey), view?.origin ?? 'origin unknown', envLabel(view?.env ?? r.env), `generation ${r.generation}`].join(', '),
      declaredStatus: r.declaredStatus, capturedAt: r.capturedAt, body: r.body,
      reviewRequest: d.includeReviewRequest && s.review.requestTemplate.trim() !== '' ? s.review.requestTemplate : null, includeSessionRef: s.review.includeSessionRef,
    });
    return { message, parts: splitMessage(message, d.reportId, s.review.maxPartChars) };
  }

  /** Stores the message and part list, keeping a part's copy mark only when the message and that part did not change. */
  function prepareInto(d: Delivery, actor: ActorRef): { message: string; partCount: number; changed: boolean } {
    const { message, parts } = messageFor(d);
    const sha = hashHex(message);
    const infos: DeliveryPartInfo[] = parts.map((p) => {
      const partSha = hashHex(p.text);
      const before = sha === d.messageSha256 ? d.parts.find((o) => o.index === p.index && o.total === p.total && o.sha256 === partSha) : undefined;
      return { index: p.index, total: p.total, chars: p.text.length, sha256: partSha, copiedAt: before?.copiedAt ?? null };
    });
    const changed = sha !== d.messageSha256 || infos.length !== d.parts.length || infos.some((p, i) => p.sha256 !== d.parts[i]?.sha256);
    if (changed) {
      const replaced = d.messageSha256 !== null;
      d.messageSha256 = sha; d.messageChars = message.length; d.parts = infos;
      addEvent(d, 'prepared', { actor, detail: { sha256: sha, chars: message.length, partCount: parts.length, replacedEarlierMessage: replaced } });
    }
    return { message, partCount: parts.length, changed };
  }

  function freeze(c: Conversation, resolvedFrom: DeliveryResolution): NonNullable<Delivery['destination']> {
    return { conversationId: c.id, url: c.url, title: c.title, chatgptConversationId: c.chatgptConversationId, resolvedFrom, verificationAtFreeze: c.verification, frozenAt: nowIso() };
  }

  function resolveAutomatic(r: { projectId: string | null; sessionKey: string }): { destination: NonNullable<Delivery['destination']> | null; reason: string | null } {
    if (!r.projectId) return { destination: null, reason: 'This session is not assigned to a project, so there is no conversation to send to.' };
    const project = projectOf(r.projectId);
    if (!project) return { destination: null, reason: 'The project this report belongs to no longer exists.' };
    const own = data().conversations.filter((c) => c.projectId === project.id).sort((a, b) => a.position - b.position);
    const preferred = own.find((c) => c.id === project.preferredConversationId);
    if (preferred) return { destination: freeze(preferred, 'project_preferred'), reason: null };
    if (own.length === 1) return { destination: freeze(own[0], 'only_conversation'), reason: null };
    return { destination: null, reason: own.length === 0 ? 'No ChatGPT conversation is mapped to this project yet.' : `This project has ${own.length} conversations and none is the preferred one, so Mini-Summa will not guess.` };
  }

  function createDelivery(report: Report | ReportSummary, body: { conversationId?: string; includeReviewRequest?: boolean }, actor: ActorRef): Delivery {
    const resolution = body.conversationId ? { destination: freeze(conversationOf(body.conversationId), 'user_selected'), reason: null } : resolveAutomatic(report);
    const state: DeliveryState = resolution.destination ? stateForVerification(resolution.destination.verificationAtFreeze) : 'destination_missing';
    const at = nowIso();
    const d: Delivery = {
      id: next('dlv'), reportId: report.id, projectId: report.projectId, projectName: report.projectName, sessionKey: report.sessionKey, taskTitle: report.taskTitle,
      state, destination: resolution.destination, review: 'none', includeReviewRequest: (body.includeReviewRequest ?? true) && settings().review.requestTemplate.trim() !== '',
      messageSha256: null, messageChars: null, parts: [], followUpDraft: null, attempts: 0, lastError: null, stateChangedAt: at, createdAt: at, updatedAt: at,
    };
    data().deliveries.push(d);
    addEvent(d, 'created', { from: null, to: 'report_captured', actor, detail: { reportId: report.id } });
    addEvent(d, 'destination_resolved', { from: 'report_captured', to: state, actor, detail: { destination: resolution.destination && { title: resolution.destination.title, url: resolution.destination.url, resolvedFrom: resolution.destination.resolvedFrom }, reason: resolution.reason } });
    return commit(d, {});
  }

  async function copyPart(d: Delivery, requested: number | undefined, actor: ActorRef): Promise<{ delivery: Delivery; part: number; partCount: number; clipboard: 'native' | 'client'; text: string | null }> {
    guard(d, { verb: 'copied', allowed: COPY_FROM, needsDestination: true });
    prepareInto(d, actor);
    const total = d.parts.length;
    const index = requested ?? d.parts.find((p) => p.copiedAt === null)?.index ?? 1;
    if (!Number.isInteger(index) || index < 1 || index > total) {
      throw new ApiError(400, 'part_out_of_range', `There is no part ${index}. This message has ${total} part${total === 1 ? '' : 's'}.`);
    }
    const text = messageFor(d).parts[index - 1].text;
    const clipboard = st().clipboard;
    d.parts = d.parts.map((p) => (p.index === index ? { ...p, copiedAt: nowIso() } : p));
    addEvent(d, 'part_copied', { from: d.state, to: 'copied', actor, detail: { part: index, partCount: total, chars: text.length, clipboard } });
    commit(d, { state: 'copied', attempts: index === 1 ? d.attempts + 1 : d.attempts });
    return { delivery: d, part: index, partCount: total, clipboard, text: clipboard === 'client' ? text : null };
  }

  async function openDestination(d: Delivery, actor: ActorRef): Promise<{ delivery: Delivery; open: ChatGptOpenResult }> {
    guard(d, { verb: 'opened', allowed: OPEN_FROM, needsDestination: true });
    const url = d.destination!.url;
    server.onOpen?.(url);
    const open = st().open(url);
    let nextState: DeliveryState = d.state;
    if (open.ok && (d.state === 'copied' || d.state === 'awaiting_user_send')) nextState = 'awaiting_user_send';
    const lastError = !open.ok ? open.note ?? 'ChatGPT could not be opened.' : open.verified === false ? open.note ?? 'The page that opened may not be the conversation this report is meant for.' : null;
    if (open.ok) addEvent(d, 'destination_opened', { from: d.state, to: nextState, actor, detail: { mode: open.mode, focused: open.focused, verified: open.verified } });
    else addEvent(d, 'note', { actor, detail: { action: 'open_failed', note: open.note } });
    commit(d, { state: nextState, lastError });
    return { delivery: d, open };
  }

  const handlers: HandlerMap = {
    'reports.list': guarded('reports.list', (i) => {
      const limit = Number(i.query?.limit ?? 50);
      const before = i.query?.before;
      const sorted = data().reports
        .filter((r) => (!i.query?.projectId || r.projectId === i.query.projectId) && (String(i.query?.unread) !== 'true' || !r.read))
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt) || b.id.localeCompare(a.id));
      const start = before ? sorted.findIndex((r) => `${r.capturedAt}|${r.id}` === before) + 1 : 0;
      const page = sorted.slice(start, start + limit);
      return { items: page, nextBefore: start + limit < sorted.length ? `${page.at(-1)!.capturedAt}|${page.at(-1)!.id}` : null };
    }),

    'candidates.list': guarded('candidates.list', (i) => st().candidates.filter((c) => (!i.query?.projectId || c.projectId === i.query.projectId) && (String(i.query?.includePromoted) === 'true' || !c.promoted))),
    'candidates.promote': guarded('candidates.promote', (i) => {
      const c = st().candidates.find((x) => x.id === i.params.id);
      if (!c) throw notFound('That final message');
      const existing = data().reports.find((r) => r.id === c.id);
      if (existing) return existing;
      const body = c.body;
      const report: Report = {
        id: c.id, projectId: c.projectId, projectName: c.projectName, sessionKey: c.sessionKey, env: c.env, sessionId: c.sessionId, generation: c.generation,
        taskTitle: c.taskTitle?.trim() || body.replace(/^[\s#>*-]+/, '').split('\n')[0].slice(0, 80) || 'Final message promoted to a report', declaredStatus: c.declaredStatus ?? 'partial',
        source: 'user_promoted', capturedAt: c.capturedAt, late: c.late, read: false, chars: body.length, excerpt: body.replace(/\s+/g, ' ').trim().slice(0, 240), delivery: null,
        promptId: c.promptId, taskId: c.id, cwd: null, body, bodySha256: c.bodySha256, stopHookActive: false, verified: false,
        note: `Promoted by you from a final message that did not follow the report protocol (${c.reason}). The status is a declaration by Claude, not evidence that the work was done or tested.`,
        redactions: c.redactions, deliveries: [],
      };
      data().reports.unshift(report);
      c.promoted = true;
      emit({ type: 'report.upserted', report });
      createDelivery(report, {}, { kind: 'system' });
      emitCounts();
      return reportOf(c.id);
    }),

    'deliveries.get': guarded('deliveries.get', (i): DeliveryDetail => ({ ...deliveryOf(i.params.id), events: [...(st().events.get(i.params.id) ?? [])] })),
    'deliveries.create': guarded('deliveries.create', (i) => createDelivery(reportOf(i.params.id), (i.body ?? {}) as { conversationId?: string; includeReviewRequest?: boolean }, DESKTOP)),
    'deliveries.prepare': guarded('deliveries.prepare', (i) => {
      const d = deliveryOf(i.params.id);
      if (CLOSED.includes(d.state)) {
        if (d.messageSha256 === null) throw new ApiError(409, 'delivery_closed', `This handoff was ${d.state === 'user_discarded' ? 'discarded' : 'already marked as sent'}, so it cannot be prepared.`);
        return { delivery: d, message: messageFor(d).message, partCount: d.parts.length };
      }
      const { message, partCount, changed } = prepareInto(d, DESKTOP);
      if (changed) commit(d, {});
      return { delivery: d, message, partCount };
    }),
    'deliveries.part': guarded('deliveries.part', (i) => {
      const d = deliveryOf(i.params.id);
      const parts = messageFor(d).parts;
      const index = Number(i.params.index);
      if (!Number.isInteger(index) || index < 1 || index > parts.length) throw new ApiError(400, 'part_out_of_range', `There is no part ${index}. This message has ${parts.length} part${parts.length === 1 ? '' : 's'}.`);
      return { index, total: parts.length, text: parts[index - 1].text, sha256: hashHex(parts[index - 1].text) };
    }),
    'deliveries.copy': guarded('deliveries.copy', (i) => copyPart(deliveryOf(i.params.id), (i.body as { part?: number } | undefined)?.part, DESKTOP)),
    'deliveries.open': guarded('deliveries.open', (i) => openDestination(deliveryOf(i.params.id), DESKTOP)),
    'deliveries.handoff': guarded('deliveries.handoff', async (i) => {
      const d = deliveryOf(i.params.id);
      const copied = await copyPart(d, (i.body as { part?: number } | undefined)?.part, DESKTOP);
      const opened = await openDestination(d, DESKTOP);
      return { delivery: opened.delivery, part: copied.part, partCount: copied.partCount, clipboard: copied.clipboard, text: copied.text, open: opened.open };
    }),
    'deliveries.confirmSent': guarded('deliveries.confirmSent', (i) => {
      const d = deliveryOf(i.params.id);
      guard(d, { verb: 'marked as sent', allowed: CONFIRM_FROM, needsDestination: true });
      addEvent(d, 'confirmed_sent', { from: d.state, to: 'user_confirmed_sent', detail: { previousState: d.state, partsCopied: d.parts.filter((p) => p.copiedAt !== null).length, partCount: d.parts.length } });
      return commit(d, { state: 'user_confirmed_sent', review: d.includeReviewRequest ? 'requested' : 'none' });
    }),
    'deliveries.markUncertain': guarded('deliveries.markUncertain', (i) => {
      const d = deliveryOf(i.params.id);
      guard(d, { verb: 'marked as uncertain', allowed: UNCERTAIN_FROM });
      addEvent(d, 'marked_uncertain', { from: d.state, to: 'delivery_uncertain', detail: { previousState: d.state } });
      return commit(d, { state: 'delivery_uncertain', review: 'none' });
    }),
    'deliveries.discard': guarded('deliveries.discard', (i) => {
      const d = deliveryOf(i.params.id);
      guard(d, { verb: 'discarded', allowed: DISCARD_FROM });
      addEvent(d, 'discarded', { from: d.state, to: 'user_discarded', detail: { previousState: d.state } });
      return commit(d, { state: 'user_discarded' });
    }),
    'deliveries.reopen': guarded('deliveries.reopen', (i) => {
      const d = deliveryOf(i.params.id);
      guard(d, { verb: 'reopened', allowed: REOPEN_FROM });
      const conv = d.destination ? data().conversations.find((c) => c.id === d.destination!.conversationId && c.url === d.destination!.url) : undefined;
      const state: DeliveryState = d.destination ? stateForVerification(conv?.verification ?? d.destination.verificationAtFreeze) : 'destination_missing';
      addEvent(d, 'reopened', { from: d.state, to: state, detail: { previousState: d.state } });
      return commit(d, { state, attempts: d.attempts + 1, lastError: null, parts: d.parts.map((p) => ({ ...p, copiedAt: null })) });
    }),
    'deliveries.setDestination': guarded('deliveries.setDestination', (i) => {
      const d = deliveryOf(i.params.id);
      guard(d, { verb: 'pointed at another conversation', allowed: DESTINATION_FROM });
      const conv = conversationOf((i.body as { conversationId: string }).conversationId);
      const destination = freeze(conv, 'user_selected');
      const state = stateForVerification(destination.verificationAtFreeze);
      addEvent(d, 'destination_changed', { from: d.state, to: state, detail: { from: d.destination && { title: d.destination.title }, to: { title: destination.title }, otherProject: conv.projectId !== d.projectId } });
      return commit(d, { state, destination, lastError: null, parts: d.parts.map((p) => ({ ...p, copiedAt: null })) });
    }),
    'deliveries.setReview': guarded('deliveries.setReview', (i) => {
      const d = deliveryOf(i.params.id);
      const body = i.body as { review: ReviewState; followUpDraft?: string | null };
      if (!REVIEW_ALLOWED[d.review].includes(body.review)) {
        throw new ApiError(409, 'invalid_review_transition', body.review === 'requested' ? 'The review is requested when you confirm the message was sent, not here.'
          : body.review === 'follow_up_sent' ? 'A follow-up counts as sent only when it has been typed into Claude from Mini-Summa.'
            : `The review cannot change from "${d.review}" to "${body.review}".`);
      }
      if (body.review === 'closed' && d.review === 'closed') return d;
      if (body.review === 'follow_up_drafted') {
        if (typeof body.followUpDraft !== 'string' || body.followUpDraft.trim() === '') throw new ApiError(400, 'follow_up_draft_required', 'Write the follow-up text before saving it as a draft.');
        addEvent(d, 'follow_up_drafted', { detail: { from: d.review, to: body.review, chars: body.followUpDraft.length } });
        return commit(d, { review: body.review, followUpDraft: body.followUpDraft });
      }
      addEvent(d, 'review_changed', { detail: { from: d.review, to: body.review } });
      return commit(d, { review: body.review });
    }),
    'deliveries.saveFile': guarded('deliveries.saveFile', (i) => {
      const d = deliveryOf(i.params.id);
      if (d.messageSha256 === null && !CLOSED.includes(d.state)) { prepareInto(d, DESKTOP); commit(d, {}); }
      const path = st().savePath;
      if (path === null) return { delivery: d, path: null };
      addEvent(d, 'note', { detail: { action: 'saved_file', path } });
      return { delivery: commit(d, {}), path };
    }),

    // ----- pending actions -----
    'actions.create': guarded('actions.create', (i) => {
      const body = i.body as { sessionKey: string; text: string; expectGeneration?: number; reportId?: string; deliveryId?: string };
      if (body.text.trim() === '') throw new ApiError(400, 'empty_prompt', 'Write something to send first.');
      const view = sessionOf(body.sessionKey);
      const expected = body.expectGeneration ?? view?.generation ?? null;
      const problem = targetProblem(view, expected);
      if (problem) throw new ApiError(422, problem.code, problem.message);
      const at = nowIso();
      const failed = st().promptFailure;
      const action: PendingAction = {
        id: next('act'), kind: 'claude_prompt', status: failed ? 'failed' : 'executed', projectId: view!.projectId, projectName: view!.projectName, sessionKey: view!.key,
        generation: expected ?? view!.generation, text: body.text, summary: body.text.split('\n')[0].slice(0, 160), reportId: body.reportId ?? null, deliveryId: body.deliveryId ?? null,
        createdAt: at, createdBy: DESKTOP, approvableBy: 'desktop', decidedAt: at, decidedBy: DESKTOP, executedAt: failed ? null : at, failure: failed,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), target: { managed: true, live: true, generation: view!.generation, generationMatches: true, state: view!.state, problem: null },
      };
      data().actions.unshift(action);
      emit({ type: 'action.upserted', action });
      if (!failed) {
        view!.state = 'working'; view!.stateLabel = 'Working';
        emit({ type: 'session.upserted', session: view! });
        const d = body.deliveryId ? data().deliveries.find((x) => x.id === body.deliveryId) : undefined;
        if (d) {
          if (d.review === 'follow_up_drafted') { addEvent(d, 'review_changed', { actor: { kind: 'system' }, detail: { from: 'follow_up_drafted', to: 'follow_up_sent', actionId: action.id } }); commit(d, { review: 'follow_up_sent' }); }
          else { addEvent(d, 'note', { actor: { kind: 'system' }, detail: { action: 'prompt_typed', actionId: action.id } }); commit(d, {}); }
        }
      }
      emitCounts();
      return action;
    }),
    'actions.list': guarded('actions.list', (i) => data().actions.filter((a) => {
      const status = i.query?.status ?? 'open';
      const statusOk = status === 'all' || (status === 'pending' ? a.status === 'pending' : a.status === 'pending' || a.status === 'approved');
      return statusOk && (!i.query?.projectId || a.projectId === i.query.projectId);
    })),
    'actions.approve': guarded('actions.approve', (i) => {
      const a = data().actions.find((x) => x.id === i.params.id);
      if (!a) throw notFound('That request');
      if (a.status !== 'pending') throw new ApiError(409, 'action_not_pending', `This request is already ${a.status}, so it cannot be approved.`);
      if (Date.parse(a.expiresAt) <= Date.now()) { a.status = 'expired'; emit({ type: 'action.upserted', action: a }); throw new ApiError(409, 'action_expired', 'This request has expired, so nothing was typed. Send it again if you still want it.'); }
      const view = sessionOf(a.sessionKey);
      const problem = targetProblem(view, a.generation, a.kind === 'permission' ? ['needs_permission'] : undefined);
      Object.assign(a, { decidedAt: nowIso(), decidedBy: DESKTOP });
      if (problem) Object.assign(a, { status: 'failed', failure: problem.message });
      else Object.assign(a, { status: 'executed', executedAt: nowIso(), failure: null });
      if (!problem && view) { view.state = 'working'; view.stateLabel = 'Working'; view.attention = null; emit({ type: 'session.upserted', session: view }); }
      for (const act of data().activity) if (act.sessionKey === a.sessionKey && act.requiresAction && act.resolvedAt === null && !problem) { act.resolvedAt = nowIso(); emit({ type: 'activity.updated', activity: act }); }
      emit({ type: 'action.upserted', action: a });
      emitCounts();
      return a;
    }),
    'actions.reject': guarded('actions.reject', (i) => {
      const a = data().actions.find((x) => x.id === i.params.id);
      if (!a) throw notFound('That request');
      if (a.status !== 'pending') throw new ApiError(409, 'action_not_pending', `This request is already ${a.status}, so it cannot be rejected.`);
      Object.assign(a, { status: 'rejected', decidedAt: nowIso(), decidedBy: DESKTOP });
      emit({ type: 'action.upserted', action: a });
      emitCounts();
      return a;
    }),

    // ----- activity and notifications -----
    'activity.list': guarded('activity.list', (i) => {
      const q = i.query ?? {};
      const limit = Number(q.limit ?? 50);
      const order = (a: ActivityEvent, b: ActivityEvent) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
      const sorted = data().activity
        .filter((a) => (!q.projectId || a.projectId === q.projectId) && (!q.type || a.type === q.type)
          && (String(q.unread) !== 'true' || !a.read) && (String(q.requiresAction) !== 'true' || (a.requiresAction && a.resolvedAt === null)))
        .sort(order);
      const start = q.before ? sorted.findIndex((a) => `${a.at}|${a.id}` === q.before) + 1 : 0;
      const page = sorted.slice(start, start + limit);
      return { items: page, nextBefore: start + limit < sorted.length ? `${page.at(-1)!.at}|${page.at(-1)!.id}` : null };
    }),
    'notifications.list': guarded('notifications.list', (i) => [...data().notifications].sort((a, b) => b.at.localeCompare(a.at)).slice(0, Number(i.query?.limit ?? 50))),

    // ----- hooks -----
    'hooks.plan': guarded('hooks.plan', (i) => { const body = i.body as { env: EnvId; action: 'install' | 'uninstall' }; return planHooks(body.env, body.action); }),
    'hooks.apply': guarded('hooks.apply', (i) => {
      const body = i.body as { env: EnvId; action: 'install' | 'uninstall'; planHash: string };
      if (st().hookDrift.delete(body.env)) {
        // Another program edited settings.json after the plan was shown.
        const current = JSON.parse(st().hookFiles.get(body.env) ?? '{}') as Record<string, unknown>;
        st().hookFiles.set(body.env, pretty({ ...current, editedElsewhere: true }));
      }
      const fresh = planHooks(body.env, body.action);
      if (fresh.action === 'noop') return fresh.status;
      if (fresh.planHash !== body.planHash) {
        throw new ApiError(409, 'plan_stale', 'settings.json changed since this plan was shown, or the plan is no longer valid. Review the new plan and apply that one.');
      }
      st().hookFiles.set(body.env, fresh.after);
      const status = data().hooks.find((h) => h.env === body.env)!;
      status.installed = body.action === 'install';
      status.events = status.installed ? [...HOOK_EVENTS] : [];
      status.missingEvents = status.installed ? [] : [...HOOK_EVENTS];
      status.issues = status.installed ? [] : ['Hooks are not installed in this environment.'];
      emit({ type: 'hooks.changed', env: status.env, status });
      return status;
    }),

    // ----- devices and pairing -----
    'pairing.createOffer': guarded('pairing.createOffer', (i) => {
      const body = (i.body ?? {}) as { scopes?: Scope[]; kind?: 'phone' | 'extension' };
      const kind = body.kind ?? 'phone';
      const scopes: Scope[] = kind === 'extension' ? ['extension'] : [...new Set<Scope>(body.scopes ?? ['read', 'notify'])];
      const id = next('ofr');
      const code = `${hashHex(id).slice(0, 4)}-${hashHex(`${id}x`).slice(0, 4)}-${hashHex(`${id}y`).slice(0, 4)}`.toUpperCase();
      const expiresAt = new Date(st().now() + 5 * 60_000).toISOString();
      const urls = kind === 'extension' ? ['http://127.0.0.1:47811'] : ['https://dev-pc.tail1a2b3.ts.net', 'http://127.0.0.1:47811'];
      st().offers.set(id, { scopes, kind, expiresAt });
      return { id, code, expiresAt, scopes, urls, qrPayload: encodePairingPayload({ version: 1, code, offerId: id, urls, name: 'DEV-PC' }) };
    }),
    'devices.list': guarded('devices.list', () => data().devices),
    'devices.update': guarded('devices.update', (i) => {
      const body = i.body as { name?: string; trusted?: boolean; scopes?: Scope[] };
      const d = data().devices.find((x) => x.id === i.params.id);
      if (!d) throw notFound('That device');
      if (d.revokedAt !== null) throw new ApiError(409, 'device_revoked', 'This device was revoked, so it cannot be changed. Pair it again to use it.');
      if (body.scopes !== undefined && d.platform === 'extension' && (body.scopes.length !== 1 || body.scopes[0] !== 'extension')) {
        throw new ApiError(400, 'scope_not_allowed', 'The browser extension always has the "extension" permission and nothing else. Leave its permissions as they are.');
      }
      if (body.name !== undefined) d.name = body.name;
      if (body.trusted !== undefined) d.trusted = body.trusted;
      if (body.scopes !== undefined) d.scopes = body.scopes;
      emit({ type: 'device.upserted', device: d });
      return d;
    }),
    // As the real core: a revoked device stays in the list marked as revoked, and what it still had waiting is dropped.
    'devices.revoke': guarded('devices.revoke', (i) => {
      const d = data().devices.find((x) => x.id === i.params.id);
      if (!d) throw notFound('That device');
      if (d.revokedAt === null) {
        Object.assign(d, { revokedAt: nowIso(), pushRegistered: false });
        for (const a of data().actions) {
          if (a.status === 'pending' && a.createdBy.kind === 'device' && a.createdBy.deviceId === d.id) {
            Object.assign(a, { status: 'rejected', decidedAt: nowIso(), decidedBy: { kind: 'system' } as ActorRef, failure: 'The device that asked was removed.' });
            emit({ type: 'action.upserted', action: a });
          }
        }
        emit({ type: 'device.upserted', device: d });
        emitCounts();
      }
      return { ok: true as const };
    }),

    // ----- push and tailscale -----
    'push.configure': guarded('push.configure', (i) => {
      let parsed: { client_email?: string; private_key?: string; project_id?: string };
      try { parsed = JSON.parse((i.body as { serviceAccountJson: string }).serviceAccountJson) as typeof parsed; } catch { throw new ApiError(400, 'invalid_service_account', 'That is not valid JSON. Import the service account file exactly as Firebase gave it to you.'); }
      if (!parsed.client_email || !parsed.private_key || !parsed.project_id) throw new ApiError(400, 'invalid_service_account', 'That file is not a Firebase service account. It needs client_email, private_key and project_id.');
      data().settings = mergeSettings(data().settings, { mobile: { push: { provider: 'fcm', configured: true } } });
      emit({ type: 'settings.changed', settings: data().settings });
      return { ok: true, configured: true, firebaseProject: parsed.project_id };
    }),
    'push.clear': guarded('push.clear', () => {
      data().settings = mergeSettings(data().settings, { mobile: { push: { provider: 'none', configured: false } } });
      emit({ type: 'settings.changed', settings: data().settings });
      return { ok: true };
    }),
    'push.test': guarded('push.test', () => {
      if (!data().settings.mobile.push.configured) return { sent: 0, failed: 0, skipped: 'Push is not set up yet. Add your Firebase service account in Settings first.' };
      const targets = data().devices.filter((d) => d.pushRegistered && d.revokedAt === null);
      if (targets.length === 0) return { sent: 0, failed: 0, skipped: 'No phone has registered for push yet. Open the Android app and allow notifications.' };
      return { sent: targets.length, failed: 0, skipped: null };
    }),
    'tailscale.status': guarded('tailscale.status', () => ({ ...st().tailscale, checkedAt: nowIso() })),
    'tailscale.setServe': guarded('tailscale.setServe', (i) => {
      const enabled = (i.body as { enabled: boolean }).enabled;
      const t = st().tailscale;
      if (enabled) {
        if (!t.installed || !t.running || !t.loggedIn || t.serve.funnelDetected) return { ...t, checkedAt: nowIso() };
        if (st().serveProblem) return { ...t, problem: st().serveProblem, checkedAt: nowIso() };
        t.serve = { configured: true, url: `https://${t.dnsName}`, target: 'http://127.0.0.1:47811', funnelDetected: false };
      } else if (t.serve.configured) t.serve = { configured: false, url: null, target: null, funnelDetected: false };
      st().tailscale = t;
      emit({ type: 'tailscale.changed', status: t });
      return { ...t, checkedAt: nowIso() };
    }),

    // ----- data -----
    'data.usage': guarded('data.usage', () => ({
      dataDir: 'C:\\Users\\dev\\AppData\\Roaming\\Mini-Summa', databaseBytes: 1_480_000 + data().activity.length * 900, rawEvents: 2410, activity: data().activity.length, reports: data().reports.length,
      deliveries: data().deliveries.length, notifications: data().notifications.length, oldestRawEventAt: new Date(Date.now() - 75 * 86_400_000).toISOString(),
    })),
    'data.prune': guarded('data.prune', (i) => {
      const dryRun = Boolean((i.body as { dryRun?: boolean } | undefined)?.dryRun);
      const r = data().settings.retention;
      const day = 86_400_000;
      const cut = (days: number) => new Date(st().now() - days * day).toISOString();
      const old = <T extends { at: string }>(list: T[], days: number, extra: (x: T) => boolean = () => true) => (days > 0 ? list.filter((x) => x.at < cut(days) && extra(x)) : []);
      const activity = old(data().activity, r.activityDays, (a) => a.read && (!a.requiresAction || a.resolvedAt !== null));
      const notifications = old(data().notifications, r.notificationsDays);
      const oldReports = r.reportsDays > 0 ? data().reports.filter((x) => x.capturedAt < cut(r.reportsDays) && (x.delivery === null || CLOSED.includes(x.delivery.state))) : [];
      const deliveries = r.reportsDays > 0 ? data().deliveries.filter((x) => x.updatedAt < cut(r.reportsDays) && CLOSED.includes(x.state)) : [];
      const rawEvents = r.rawEventsDays > 0 ? st().prunableRawEvents : 0;
      if (!dryRun) {
        const gone = new Set([...activity.map((a) => a.id)]);
        data().activity = data().activity.filter((a) => !gone.has(a.id));
        const goneN = new Set(notifications.map((n) => n.id));
        data().notifications = data().notifications.filter((n) => !goneN.has(n.id));
        const goneD = new Set(deliveries.map((d) => d.id));
        data().deliveries = data().deliveries.filter((d) => !goneD.has(d.id));
        const goneR = new Set(oldReports.map((x) => x.id));
        data().reports = data().reports.filter((x) => !goneR.has(x.id));
        st().prunableRawEvents = 0;
        emitCounts();
      }
      return { dryRun, removed: { rawEvents, activity: activity.length, notifications: notifications.length, reports: oldReports.length, deliveries: deliveries.length } };
    }),
  };

  // ----- helpers that need the closure -----

  const ACCEPTS_INPUT = ['idle', 'waiting_for_you', 'turn_ended', 'report_ready'];

  function targetProblem(view: SessionView | undefined, generation: number | null, accepts: string[] = ACCEPTS_INPUT): { code: string; message: string } | null {
    const hint = 'Mini-Summa only observes sessions it did not start, so it never types into them. Remote Control can control this session from the Claude app.';
    if (!view || view.origin !== 'managed') return { code: 'target_not_managed', message: `This session was not started by Mini-Summa. ${hint}` };
    if (view.availability !== 'live') return { code: 'target_not_live', message: 'This session is not running right now, so nothing can be typed into it.' };
    if (generation !== null && generation !== view.generation) return { code: 'target_generation_changed', message: 'This session was restarted since the request was made, so nothing was typed.' };
    if (!accepts.includes(view.state)) return { code: 'target_unavailable', message: `Claude is not ready for input (${view.stateLabel.toLowerCase()}). Wait until it is waiting for you.` };
    return null;
  }

  function planHooks(env: EnvId, action: 'install' | 'uninstall'): HookPlan {
    const status: HookStatus | undefined = data().hooks.find((h) => h.env === env);
    if (!status) throw new ApiError(422, 'environment_unavailable', `Mini-Summa could not look at ${envLabel(env)}.`);
    const before = st().hookFiles.get(env) ?? '';
    const root = (before.trim() === '' ? {} : JSON.parse(before)) as Record<string, unknown>;
    const nextRoot = action === 'install' ? withHooks(root, env) : withoutHooks(root);
    const after = pretty(nextRoot);
    const noop = after === before;
    const warnings: string[] = [];
    if (!noop && action === 'install') warnings.push('Sessions that Mini-Summa starts in its own terminals always get these hooks through a private settings file, so they work without this install. This install adds capture for Claude Code sessions you start yourself in a normal terminal.');
    if (!noop && action === 'uninstall') warnings.push('Only Mini-Summa\'s own hook entries are removed. Your other settings and hooks are not touched. Sessions started in Mini-Summa terminals keep working.');
    const planAction: HookPlan['action'] = noop ? 'noop' : action;
    return {
      env, settingsPath: status.settingsPath, planHash: hashHex(`${env}${planAction}${status.settingsPath}${before}${after}`), action: planAction, before, after,
      unifiedDiff: noop ? '' : unifiedDiff(before, after, status.settingsPath, false),
      backupPath: noop ? '' : `C:\\Users\\dev\\AppData\\Roaming\\Mini-Summa\\backups\\settings-${env.replace(/[^a-z0-9]+/gi, '-')}-20261030-143012.json`,
      warnings, status: structuredClone(status),
    };
  }

  return handlers;
}

// ---------------------------------------------------------------------------------------------------------------
// Things a test or a screenshot script does to a running demo server

/** Simulates the phone redeeming an offer: a device appears, as it would when the app scans the QR code. */
export function redeemOffer(server: DemoServer, offerId: string, name = 'Pixel 8', platform: Device['platform'] = 'android'): Device {
  const offer = featureState(server.data).offers.get(offerId);
  if (!offer) throw new Error(`No pairing offer ${offerId}.`);
  const device: Device = {
    id: `dev_${offerId}`, name, platform, scopes: offer.scopes, trusted: false, pushRegistered: false, createdAt: nowIso(), lastSeenAt: nowIso(), lastSeenVia: 'tailscale', revokedAt: null,
  };
  server.data.devices.push(device);
  server.transport.emit(structuredClone({ type: 'device.upserted' as const, device }));
  return device;
}

/** Changes a delivery the way another part of the core would, and announces it. */
export function changeDelivery(server: DemoServer, id: string, patch: Partial<Delivery>): Delivery {
  const d = server.data.deliveries.find((x) => x.id === id);
  if (!d) throw new Error(`No delivery ${id}.`);
  Object.assign(d, patch, { updatedAt: nowIso() });
  const report = server.data.reports.find((r) => r.id === d.reportId);
  if (report) {
    report.delivery = { id: d.id, state: d.state, review: d.review, destinationTitle: d.destination?.title ?? null, updatedAt: d.updatedAt };
    server.transport.emit(structuredClone({ type: 'report.upserted' as const, report }));
  }
  server.transport.emit(structuredClone({ type: 'delivery.upserted' as const, delivery: d }));
  server.transport.emit({ type: 'counts', counts: server.counts() });
  return d;
}
