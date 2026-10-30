// One handler per entry of the shared route table (`routes`). `HandlerMap` is a mapped type over every route name, so
// forgetting a route is a compile error. Handlers only translate: validation happened before them, authentication and
// scope checks too, and the services own all behaviour.
//
// Local decisions (also in the worker report):
//  * `system.state` lists projects the way `projects.list` does by default (archived ones stay hidden) and sessions
//    without ended ones; the conversations are those of the listed projects.
//  * `projects.remove` archives unless `?mode=delete` is given: deleting must be asked for.
//  * `pairing.createOffer` offers `read` + `notify` unless the caller names scopes, and only `extension` for an
//    extension offer. Phone offers list the Tailscale URL first, then this server's own address.
//  * `devices.self` describes the desktop token with a synthetic device (id `desktop`), since it has no device row.
//  * `push.configure` / `push.clear` also record `mobile.push` in the settings, as the settings schema expects.
import { API_VERSION, isSessionKey } from '@minisumma/shared';
import type { Counts, Device, HookStatus, Scope, SessionKey, StateSnapshot, SystemInfo } from '@minisumma/shared';
import type { CoreBase } from '../contracts.ts';
import { CoreError, conflict, notFound, unavailable } from '../errors.ts';
import type { ConversationActions } from './conversations.ts';
import type { HandlerMap, HttpServices } from './types.ts';

export interface HandlerDeps {
  base: CoreBase;
  services: HttpServices;
  counts: () => Counts;
  system: () => SystemInfo;
  conversations: ConversationActions;
}

const OK = { ok: true } as const;

/** `:key` arrives percent-decoded (Hono decodes path parameters once). Anything that is not `<env>|<id>` is refused. */
export function sessionKeyParam(raw: string): SessionKey {
  if (!isSessionKey(raw)) {
    throw new CoreError(400, 'validation_failed',
      'That is not a valid session key. A session key looks like posix|<id>, win|<id> or wsl:<Distro>|<id>. Copy it from the session list.',
      { param: 'key' });
  }
  return raw;
}

function partIndex(raw: string): number {
  if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1) {
    throw new CoreError(400, 'validation_failed', 'The part number must be a whole number starting at 1.', { param: 'index' });
  }
  return Number(raw);
}

export function createHandlers(deps: HandlerDeps): HandlerMap {
  const { base, services, conversations } = deps;
  const { projects, sessions, reports, deliveries, actions, activity, devices } = services;

  const requirePush = () => {
    if (!services.push) throw unavailable('Push notifications are not available in this build of Mini-Summa.', 'push_unavailable');
    return services.push;
  };

  return {
    // system
    'system.health': () => ({ ok: true, name: 'mini-summa-core', version: base.version, apiVersion: API_VERSION }),
    'system.state': () => {
      // The sequence number comes first: a client applies only events newer than `seq` on top of what follows.
      const seq = base.bus.seq;
      const list = projects.list();
      const snapshot: StateSnapshot = {
        seq,
        system: deps.system(),
        projects: list,
        conversations: list.flatMap((p) => projects.conversations.list(p.id)),
        sessions: sessions.list(),
        counts: deps.counts(),
        settings: services.settings.get(),
      };
      return snapshot;
    },
    'system.counts': () => deps.counts(),

    // projects
    'projects.list': ({ query }) => projects.list(query.includeArchived === undefined ? undefined : { includeArchived: query.includeArchived }),
    'projects.get': ({ params }) => projects.require(params.id),
    'projects.create': ({ body }) => projects.create(body),
    'projects.update': ({ params, body }) => projects.update(params.id, body),
    'projects.remove': async ({ params, query }) => {
      // A removed project must not leave Claude terminals running where nobody can see them. Ending a terminal is the
      // user's decision, so a project with running terminals is refused until the caller says to stop them.
      const running = sessions.list({ projectId: params.id }).filter((s) => s.origin === 'managed' && s.availability === 'live');
      if (running.length > 0) {
        if (!query.stopSessions) {
          throw conflict(`This project has ${running.length} running Claude terminal${running.length === 1 ? '' : 's'}. Stop ${running.length === 1 ? 'it' : 'them'} first, or confirm that Mini-Summa should stop ${running.length === 1 ? 'it' : 'them'} when removing the project.`,
            'sessions_running', { sessions: running.map((s) => s.key) });
        }
        for (const s of running) await sessions.stop(s.key, {});
      }
      // Archiving keeps the history, so it is the default; deleting must be asked for.
      projects.remove(params.id, query.mode ?? 'archive');
      return OK;
    },
    'projects.reorder': ({ body }) => { projects.reorder(body.ids); return OK; },
    'projects.addRoot': ({ params, body }) => projects.addRoot(params.id, body),
    'projects.removeRoot': ({ params }) => projects.removeRoot(params.id, params.rootId),

    // ChatGPT conversations
    'conversations.list': ({ params }) => { projects.require(params.id); return projects.conversations.list(params.id); },
    'conversations.add': ({ params, body }) => projects.conversations.add(params.id, body),
    'conversations.update': ({ params, body }) => projects.conversations.update(params.id, body),
    'conversations.remove': ({ params }) => { projects.conversations.remove(params.id); return OK; },
    'conversations.setPreferred': ({ params, body }) => projects.conversations.setPreferred(params.id, body.conversationId),
    'conversations.open': ({ params }) => conversations.open(projects.conversations.require(params.id)),
    'conversations.verify': async ({ params }) => {
      const conversation = projects.conversations.require(params.id);
      return projects.conversations.setVerification(conversation.id, await conversations.verify(conversation));
    },

    // sessions
    'sessions.list': ({ query }) => sessions.list({ projectId: query.projectId, includeEnded: query.includeEnded }),
    'sessions.get': ({ params }) => {
      const view = sessions.get(sessionKeyParam(params.key));
      if (!view) throw notFound('The session');
      return view;
    },
    'sessions.start': ({ params, body }, ctx) => { projects.require(params.id); return sessions.start(params.id, body, ctx.actor); },
    'sessions.stop': ({ params, body }) => sessions.stop(sessionKeyParam(params.key), { force: body.force }),
    'sessions.bind': ({ params, body }) => {
      const key = sessionKeyParam(params.key);
      if (body.projectId !== null) projects.require(body.projectId);
      return sessions.bind(key, body.projectId);
    },
    'sessions.setDefault': ({ params, body }) => sessions.setDefault(sessionKeyParam(params.key), body.isDefault),
    'sessions.refresh': ({ body }) => sessions.refreshDiscovery(body.env),

    // reports
    'reports.list': ({ query }) => reports.list(query),
    'reports.get': ({ params }) => reports.require(params.id),
    'reports.markRead': ({ params }) => reports.markRead(params.id),
    'candidates.list': ({ query }) => reports.listCandidates(query),
    'candidates.promote': ({ params }) => reports.promote(params.id),

    // deliveries: every step is an explicit user action, nothing here submits to ChatGPT
    'deliveries.list': ({ query }) => deliveries.list(query),
    'deliveries.get': ({ params }) => {
      const detail = deliveries.get(params.id);
      if (!detail) throw notFound('The delivery');
      return detail;
    },
    'deliveries.create': ({ params, body }, ctx) => deliveries.create(params.id, body, ctx.actor),
    'deliveries.prepare': ({ params }, ctx) => deliveries.prepare(params.id, ctx.actor),
    'deliveries.part': ({ params }) => deliveries.part(params.id, partIndex(params.index)),
    'deliveries.copy': ({ params, body }, ctx) => deliveries.copy(params.id, body.part, ctx.actor),
    'deliveries.open': ({ params }, ctx) => deliveries.open(params.id, ctx.actor),
    'deliveries.handoff': ({ params, body }, ctx) => deliveries.handoff(params.id, body.part, ctx.actor),
    'deliveries.confirmSent': ({ params, body }, ctx) => deliveries.confirmSent(params.id, body.note, ctx.actor),
    'deliveries.markUncertain': ({ params, body }, ctx) => deliveries.markUncertain(params.id, body.note, ctx.actor),
    'deliveries.discard': ({ params, body }, ctx) => deliveries.discard(params.id, body.note, ctx.actor),
    'deliveries.reopen': ({ params, body }, ctx) => deliveries.reopen(params.id, body.note, ctx.actor),
    'deliveries.setDestination': ({ params, body }, ctx) => deliveries.setDestination(params.id, body.conversationId, ctx.actor),
    'deliveries.setReview': ({ params, body }, ctx) => deliveries.setReview(params.id, body.review, body.followUpDraft, ctx.actor),
    'deliveries.saveFile': ({ params }, ctx) => deliveries.saveFile(params.id, ctx.actor),

    // pending actions: the actor is always the authenticated caller, never something the body claims
    'actions.list': ({ query }) => actions.list(query),
    'actions.create': ({ body }, ctx) => actions.createPrompt({
      sessionKey: body.sessionKey, text: body.text, expectGeneration: body.expectGeneration,
      reportId: body.reportId, deliveryId: body.deliveryId, actor: ctx.actor,
    }),
    'actions.approve': ({ params }, ctx) => actions.approve(params.id, ctx.actor),
    'actions.reject': ({ params, body }, ctx) => actions.reject(params.id, ctx.actor, body.reason),

    // activity and notifications
    'activity.list': ({ query }) => activity.list(query),
    'activity.markRead': ({ body }) => { activity.markRead(body); return deps.counts(); },
    'notifications.list': ({ query }) => services.notifications.list(query.limit),

    // settings
    'settings.get': () => services.settings.get(),
    'settings.update': ({ body }) => services.settings.update(body),

    // environments and Claude Code hooks
    'environments.list': async ({ query }) => {
      const envs = await services.environments.list(query.refresh === undefined ? undefined : { refresh: query.refresh });
      let statuses: HookStatus[] = [];
      try { statuses = await services.hooks.list(); } catch (err) {
        // One unreadable settings file must not hide the environments themselves.
        base.log.warn('http.hook_status_failed', { message: (err as Error).message });
      }
      const byEnv = new Map(statuses.map((s) => [s.env, s]));
      return envs.map((e) => ({ ...e, hooks: byEnv.get(e.id) ?? e.hooks }));
    },
    'hooks.list': () => services.hooks.list(),
    'hooks.plan': ({ body }) => services.hooks.plan(body.env, body.action),
    'hooks.apply': ({ body }) => services.hooks.apply(body.env, body.action, body.planHash),

    // devices and pairing
    'pairing.createOffer': ({ body }, ctx) => {
      const kind = body.kind ?? 'phone';
      // A browser extension is only ever offered its own scope; a phone defaults to looking and being notified.
      const scopes: Scope[] = kind === 'extension' ? ['extension'] : [...new Set<Scope>(body.scopes ?? ['read', 'notify'])];
      const urls = kind === 'extension' ? [ctx.baseUrl] : [ctx.publicUrl, ctx.baseUrl].filter((u): u is string => typeof u === 'string' && u !== '');
      return devices.createOffer(scopes, urls, kind);
    },
    'pairing.redeem': ({ body }, ctx) => devices.redeem(body, ctx.via),
    'devices.list': () => devices.list(),
    'devices.self': (_input, ctx): Device => {
      const id = ctx.principal.deviceId;
      if (id === null) {
        // The desktop token has no device row; describe it so a client can still learn its own scopes.
        const now = base.clock.now().toISOString();
        return { id: 'desktop', name: ctx.principal.name, platform: 'desktop', scopes: ctx.principal.scopes, trusted: true,
          pushRegistered: false, createdAt: now, lastSeenAt: now, lastSeenVia: ctx.via, revokedAt: null };
      }
      const device = devices.get(id);
      if (!device) throw notFound('This device');
      return device;
    },
    'devices.update': ({ params, body }) => devices.update(params.id, body),
    'devices.revoke': ({ params }) => { devices.revoke(params.id); return OK; },
    'devices.registerPush': ({ body }, ctx) => {
      if (ctx.principal.deviceId === null) {
        throw new CoreError(400, 'bad_request', 'Only a paired device can register a push token. The desktop app does not receive push notifications.');
      }
      devices.registerPush(ctx.principal.deviceId, body.provider, body.token);
      return OK;
    },

    // push notifications (the user's own Firebase service account)
    'push.configure': ({ body }) => {
      const { firebaseProject } = requirePush().configureFromJson(body.serviceAccountJson);
      services.settings.update({ mobile: { push: { provider: 'fcm', configured: true } } });
      return { ok: true, configured: true, firebaseProject };
    },
    'push.clear': () => {
      services.push?.clear();
      services.settings.update({ mobile: { push: { provider: 'none', configured: false } } });
      return OK;
    },
    'push.test': () => services.notifications.sendTest(),

    // remote access
    'tailscale.status': ({ query }) => services.tailscale.status(query.refresh === undefined ? undefined : { refresh: query.refresh }),
    'tailscale.setServe': ({ body }) => services.tailscale.setServe(body.enabled),

    // data
    'data.usage': () => services.data.usage(),
    'data.prune': ({ body }) => services.data.prune({ dryRun: body.dryRun }),
  };
}
