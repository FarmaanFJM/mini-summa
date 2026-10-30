// More demo data for the reports, activity, settings and onboarding features: a long report that splits into parts, a report
// full of code fences and markup, unmarked final messages, a phone prompt waiting for approval, sessions in every eligibility
// state, a longer feed, notifications with every outcome, and devices in every condition.
//
// `extendSeed` changes a DemoData in place (tests pass the result as the seed). `applyFeatureScenario` does the same to a
// running server and announces what is new, so a screenshot script can build the scene in a live page.
import type {
  ActivityEvent, Conversation, Delivery, DeliveryState, Device, NotificationRecord, PendingAction, Report, ReportCandidate, ReviewState, SessionKey, SessionView,
} from '@minisumma/shared';
import { featureState } from './features-handlers';
import { createSeed, IDS } from './seed';
import type { DemoData } from './seed';
import type { DemoServer } from './server';

export const FEATURE_IDS = {
  fenced: 'rpt_fenced',
  long: 'rpt_long',
  copied: 'rpt_copied',
  sessions: {
    gmReady: 'win|e5f6a7b8-1c2d-4e3f-8a9b-0c1d2e3f4a5c',
    gmEnded: 'win|2a3b4c5d-6e7f-4809-9a1b-c2d3e4f5a6b7',
  },
  actions: { phonePrompt: 'act_phone_1', stalePrompt: 'act_phone_2' },
  candidates: { plain: 'cand_plain', malformed: 'cand_malformed', promoted: 'cand_promoted' },
} as const;

const MIN = 60_000;
const at = (now: Date, minutesAgo: number): string => new Date(now.getTime() - minutesAgo * MIN).toISOString();

/** A deterministic body of roughly this many characters: headings, bullet lists and a table of test results. */
export function longBody(chars: number): string {
  const lines: string[] = ['# Migration of the clone pipeline', '', 'This report lists every change made while moving the clone pipeline to libgit2 1.9.', ''];
  let n = 1;
  while (lines.join('\n').length < chars) {
    lines.push(`## Step ${n}: ${['Replace the transport layer', 'Port the progress callbacks', 'Update the credential helpers', 'Rewrite the retry policy', 'Cover the failure paths'][n % 5]}`, '');
    lines.push(`- Touched src/clone/step${n}.ts and its test file test/clone/step${n}.test.ts.`);
    lines.push(`- The new code path is used when the remote answers with a redirect (case ${n}).`);
    lines.push(`- Ran the focused suite: ${40 + (n % 17)} tests, ${n % 7 === 0 ? '1 skipped' : 'none skipped'}, all passing.`, '');
    lines.push('```ts', `export async function stepOne${n}(remote: Remote): Promise<void> {`, `  const result = await remote.fetch({ depth: ${n % 3 === 0 ? 1 : 50} });`, '  if (!result.ok) throw new CloneError(result.reason);', '}', '```', '');
    n += 1;
  }
  return `${lines.join('\n')}\n## Not done\n- Windows long-path handling is untested.\n`;
}

export const FENCED_BODY = [
  'The release script now fails fast when the tag already exists.',
  '',
  '## What changed',
  '- `scripts/release.sh` checks `git tag --list` before it builds anything.',
  '- The error names the tag and says how to delete it.',
  '',
  '```bash',
  'if git rev-parse "v$VERSION" >/dev/null 2>&1; then',
  '  echo "Tag v$VERSION already exists. Delete it with: git tag -d v$VERSION" >&2',
  '  exit 1',
  'fi',
  '```',
  '',
  'Output of the new test, including a line that looks like markup:',
  '',
  '```text',
  '<img src=x onerror="alert(1)">',
  '<script>document.title = "hijacked"</script>',
  '```',
  '',
  'The CI token was printed once in the log, shown here as [REDACTED] and again as [REDACTED].',
  '',
  '   Indented text keeps its indentation.',
  '',
  'Done.',
].join('\n');

function spec(now: Date, over: { id: string; project: string; projectName: string; session: SessionKey; title: string; status: Report['declaredStatus']; minutesAgo: number; body: string; read?: boolean; redactions?: number }): Report {
  const sep = over.session.indexOf('|');
  return {
    id: over.id, projectId: over.project, projectName: over.projectName, sessionKey: over.session, env: over.session.slice(0, sep) as Report['env'], sessionId: over.session.slice(sep + 1),
    generation: 1, taskTitle: over.title, declaredStatus: over.status, source: 'marker', capturedAt: at(now, over.minutesAgo), late: false, read: over.read ?? false,
    chars: over.body.length, excerpt: over.body.replace(/\s+/g, ' ').trim().slice(0, 240), delivery: null, promptId: null, taskId: `task_${over.id}`, cwd: null, body: over.body,
    bodySha256: over.id.padEnd(64, '0'), stopHookActive: false, verified: false, note: 'Declared by Claude. Not verified by Mini-Summa.', redactions: over.redactions ?? 0, deliveries: [],
  };
}

function deliveryFor(now: Date, data: DemoData, report: Report, state: DeliveryState, review: ReviewState = 'none'): Delivery {
  const project = data.projects.find((p) => p.id === report.projectId);
  const conv: Conversation | undefined = data.conversations.find((c) => c.id === project?.preferredConversationId);
  const d: Delivery = {
    id: `dlv_${report.id}`, reportId: report.id, projectId: report.projectId, projectName: report.projectName, sessionKey: report.sessionKey, taskTitle: report.taskTitle,
    state, review, destination: conv ? { conversationId: conv.id, url: conv.url, title: conv.title, chatgptConversationId: conv.chatgptConversationId, resolvedFrom: 'project_preferred', verificationAtFreeze: conv.verification, frozenAt: report.capturedAt } : null,
    includeReviewRequest: true, messageSha256: null, messageChars: null, parts: [], followUpDraft: null, attempts: 0, lastError: null,
    stateChangedAt: report.capturedAt, createdAt: report.capturedAt, updatedAt: at(now, 1),
  };
  report.delivery = { id: d.id, state, review, destinationTitle: d.destination?.title ?? null, updatedAt: d.updatedAt };
  report.deliveries = [report.delivery];
  return d;
}

function session(now: Date, key: SessionKey, over: Partial<SessionView> & Pick<SessionView, 'origin' | 'availability' | 'state' | 'stateLabel'>): SessionView {
  const sep = key.indexOf('|');
  return {
    key, env: key.slice(0, sep) as SessionView['env'], sessionId: key.slice(sep + 1), termination: null, resumable: false, projectId: null, projectName: null,
    projectResolution: 'managed', cwd: null, name: null, stateEvidence: 'managed:pty', generation: 1, pid: 4200, startedAt: at(now, 50), lastActivityAt: at(now, 2), attention: null,
    unresolvedOrdering: 0, terminal: over.origin === 'managed' ? { cols: 120, rows: 32, exited: false } : null, isProjectDefault: false,
    remoteControl: { state: 'unknown', hint: 'Type /remote-control in that session to control it from the Claude app or the web.' }, ...over,
  };
}

export interface FeatureAdditions {
  sessions: SessionView[]; reports: Report[]; deliveries: Delivery[]; activity: ActivityEvent[]; notifications: NotificationRecord[]; actions: PendingAction[]; devices: Device[];
  candidates: ReportCandidate[];
}

/** Adds the feature scenes to `data` and says what is new. */
export function extendSeed(data: DemoData, now: Date = new Date()): FeatureAdditions {
  const gm = data.projects.find((p) => p.id === IDS.gitManager)!;
  const atlas = data.projects.find((p) => p.id === IDS.atlas)!;

  const sessions: SessionView[] = [
    session(now, FEATURE_IDS.sessions.gmReady, { origin: 'managed', availability: 'live', state: 'waiting_for_you', stateLabel: 'Waiting for you', projectId: gm.id, projectName: gm.name, cwd: 'C:\\Dev\\GitManager', startedAt: at(now, 30) }),
    session(now, FEATURE_IDS.sessions.gmEnded, {
      origin: 'managed', availability: 'resumable', state: 'turn_ended', stateLabel: 'Finished a turn', projectId: gm.id, projectName: gm.name, cwd: 'C:\\Dev\\GitManager', resumable: true,
      termination: { kind: 'observed', reason: 'The session ended (SessionEnd hook).', at: at(now, 200) }, terminal: { cols: 120, rows: 32, exited: true }, pid: null, startedAt: at(now, 400), lastActivityAt: at(now, 200),
    }),
  ];
  data.sessions.push(...sessions);

  const reports: Report[] = [
    spec(now, { id: FEATURE_IDS.fenced, project: gm.id, projectName: gm.name, session: IDS.s.gmWorking as SessionKey, title: 'Make the release script fail fast', status: 'complete', minutesAgo: 4, body: FENCED_BODY, redactions: 3 }),
    spec(now, { id: FEATURE_IDS.long, project: gm.id, projectName: gm.name, session: IDS.s.gmWorking as SessionKey, title: 'Move the clone pipeline to libgit2 1.9', status: 'partial', minutesAgo: 35, body: longBody(30_000) }),
    spec(now, { id: FEATURE_IDS.copied, project: atlas.id, projectName: atlas.name, session: IDS.s.atlasIdle as SessionKey, title: 'Add pagination to the audit log endpoint', status: 'complete', minutesAgo: 70, body: 'Added `limit` and `before` to GET /audit. The cursor is opaque. Tests cover the last page and an invalid cursor.\n', read: true }),
  ];
  const deliveries = [
    deliveryFor(now, data, reports[0], 'ready_for_handoff'),
    deliveryFor(now, data, reports[1], 'ready_for_handoff'),
    deliveryFor(now, data, reports[2], 'copied'),
  ];
  data.reports.unshift(...reports);
  data.deliveries.push(...deliveries);

  const candidates: ReportCandidate[] = [
    {
      id: FEATURE_IDS.candidates.plain, projectId: gm.id, projectName: gm.name, sessionKey: IDS.s.gmExternal as SessionKey, env: 'win', sessionId: IDS.s.gmExternal.slice(IDS.s.gmExternal.indexOf('|') + 1), generation: 1,
      promptId: null, reason: 'The final message has no report marker.', declaredStatus: null, taskTitle: null, body: 'I looked at the failing push test. It is flaky because it reads the wall clock; a fake clock fixes it. I have not changed any files yet.\n',
      bodySha256: 'cand1'.padEnd(64, '0'), capturedAt: at(now, 25), late: false, promoted: false,
    },
    {
      id: FEATURE_IDS.candidates.malformed, projectId: atlas.id, projectName: atlas.name, sessionKey: IDS.s.atlasIdle as SessionKey, env: 'wsl:Ubuntu', sessionId: IDS.s.atlasIdle.slice(IDS.s.atlasIdle.indexOf('|') + 1), generation: 1,
      promptId: null, reason: 'The report marker is missing the task title.', declaredStatus: 'complete', taskTitle: null, body: 'Rotated the signing keys and updated the fixtures.\n<!-- mini-summa:report status=complete -->\n',
      bodySha256: 'cand2'.padEnd(64, '0'), capturedAt: at(now, 140), late: true, promoted: false, redactions: 1,
    },
    {
      id: FEATURE_IDS.candidates.promoted, projectId: gm.id, projectName: gm.name, sessionKey: IDS.s.gmExternal as SessionKey, env: 'win', sessionId: IDS.s.gmExternal.slice(IDS.s.gmExternal.indexOf('|') + 1), generation: 1,
      promptId: null, reason: 'The final message has no report marker.', declaredStatus: null, taskTitle: null, body: 'Old note that was already promoted.\n', bodySha256: 'cand3'.padEnd(64, '0'), capturedAt: at(now, 60 * 30), late: false, promoted: true,
    },
  ];
  featureState(data).candidates.push(...candidates);

  const activity: ActivityEvent[] = [];
  const kinds: [ActivityEvent['type'], ActivityEvent['source'], string][] = [
    ['turn_ended', 'claude', 'Turn ended'], ['session_started', 'claude', 'Claude session started'], ['report_ready', 'claude', 'Report ready'], ['delivery_state', 'delivery', 'Marked as sent to ChatGPT'],
  ];
  const projects = [gm, atlas];
  for (let i = 0; i < 70; i += 1) {
    const [type, source, label] = kinds[i % kinds.length];
    const p = projects[i % projects.length];
    activity.push({
      id: `act_old_${i}`, at: at(now, 60 * 24 + i * 95), projectId: p.id, projectName: p.name, source, sessionKey: null, type, severity: 'info', title: `${label}: ${p.name} task ${70 - i}`,
      description: i % 3 === 0 ? 'No report was declared. A turn ending does not mean the task is complete.' : null, requiresAction: false, resolvedAt: null,
      links: [{ kind: 'project', id: p.id }], read: i > 4,
    });
  }
  data.activity.push(...activity);

  const notifications: NotificationRecord[] = [
    ['ntf_quiet', 'act_4', 'Report ready', 'Add branch protection checks', 'suppressed_quiet', 'suppressed_quiet', 55],
    ['ntf_off', 'act_5', 'Atlas API: report ready', 'Migrate auth middleware', 'suppressed_project', 'suppressed_project', 80],
    ['ntf_dup', 'act_6', 'GitManager: session ended', 'Session a1b2c3d4 ended', 'suppressed_duplicate', 'not_applicable', 95],
    ['ntf_unavail', 'act_7', 'Trading dashboard: error', 'The process exited with code 1.', 'unavailable', 'failed', 180],
    ['ntf_push', 'act_1', 'GitManager: needs permission', 'Session b7c8d9e0 wants to run a shell command.', 'sent', 'sent', 4],
    ['ntf_disabled', 'act_9', 'Hooks changed', 'Claude Code hooks installed for Windows', 'suppressed_disabled', 'not_applicable', 60 * 30],
  ].map(([id, activityId, title, body, native, push, minutes]) => ({
    id: id as string, activityId: activityId as string, projectId: gm.id, at: at(now, minutes as number), title: title as string, body: body as string,
    native: native as NotificationRecord['native'], push: push as NotificationRecord['push'], readAt: null, target: { view: 'activity' as const },
  }));
  data.notifications.push(...notifications);

  const actions: PendingAction[] = [
    {
      id: FEATURE_IDS.actions.phonePrompt, kind: 'claude_prompt', status: 'pending', projectId: gm.id, projectName: gm.name, sessionKey: FEATURE_IDS.sessions.gmReady, generation: 1,
      text: 'Run the full test suite on Linux as well and tell me which tests are slower than two seconds.\nDo not change any files.', summary: 'Run the full test suite on Linux as well and tell me which tests are slower than two seconds.',
      reportId: null, deliveryId: null, createdAt: at(now, 6), createdBy: { kind: 'device', deviceId: 'dev_pixel', name: 'Pixel 8' }, approvableBy: 'desktop_or_other_device', decidedAt: null, decidedBy: null,
      executedAt: null, failure: null, expiresAt: new Date(now.getTime() + 54 * MIN).toISOString(), target: { managed: true, live: true, generation: 1, generationMatches: true, state: 'waiting_for_you', problem: null },
    },
    {
      id: FEATURE_IDS.actions.stalePrompt, kind: 'claude_prompt', status: 'pending', projectId: gm.id, projectName: gm.name, sessionKey: IDS.s.gmExternal as SessionKey, generation: 1,
      text: 'Summarise what you changed today.', summary: 'Summarise what you changed today.', reportId: null, deliveryId: null, createdAt: at(now, 12),
      createdBy: { kind: 'device', deviceId: 'dev_pixel', name: 'Pixel 8' }, approvableBy: 'desktop_or_other_device', decidedAt: null, decidedBy: null, executedAt: null, failure: null,
      expiresAt: new Date(now.getTime() + 48 * MIN).toISOString(),
      target: { managed: false, live: true, generation: 1, generationMatches: true, state: 'idle', problem: 'This session was not started by Mini-Summa, so it cannot be typed into.' },
    },
  ];
  data.actions.push(...actions);

  const devices: Device[] = [
    { id: 'dev_tablet', name: 'Galaxy Tab', platform: 'android', scopes: ['read', 'notify', 'prompt', 'approve'], trusted: true, pushRegistered: true, createdAt: at(now, 60 * 24 * 9), lastSeenAt: at(now, 12), lastSeenVia: 'tailscale', revokedAt: null },
    { id: 'dev_old', name: 'Old phone', platform: 'android', scopes: ['read'], trusted: false, pushRegistered: false, createdAt: at(now, 60 * 24 * 40), lastSeenAt: at(now, 60 * 24 * 12), lastSeenVia: 'localhost', revokedAt: at(now, 60 * 24 * 11) },
    { id: 'dev_ext', name: 'Chrome extension', platform: 'extension', scopes: ['extension'], trusted: false, pushRegistered: false, createdAt: at(now, 60 * 24 * 3), lastSeenAt: at(now, 1), lastSeenVia: 'localhost', revokedAt: null },
  ];
  data.devices.push(...devices);

  return { sessions, reports, deliveries, activity, notifications, actions, devices, candidates };
}

/** A fully extended seed, for tests. */
export function createFeatureSeed(now: Date = new Date()): DemoData {
  const data = createSeed(now);
  extendSeed(data, now);
  return data;
}

/** Builds the same scene on a running server and announces every new entity, so a page that is open updates live. */
export function applyFeatureScenario(server: DemoServer): FeatureAdditions {
  const added = extendSeed(server.data);
  const emit = (event: Parameters<DemoServer['transport']['emit']>[0]) => server.transport.emit(structuredClone(event));
  for (const session of added.sessions) emit({ type: 'session.upserted', session });
  for (const report of added.reports) emit({ type: 'report.upserted', report });
  for (const delivery of added.deliveries) emit({ type: 'delivery.upserted', delivery });
  for (const activity of added.activity.slice(0, 20)) emit({ type: 'activity.added', activity });
  for (const notification of added.notifications) emit({ type: 'notification.added', notification });
  for (const action of added.actions) emit({ type: 'action.upserted', action });
  for (const device of added.devices) emit({ type: 'device.upserted', device });
  emit({ type: 'counts', counts: server.counts() });
  return added;
}
