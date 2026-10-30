// The small rules behind the settings and onboarding screens, without React.
import type { ChatGptViewState, Conversation, EnvironmentInfo, HookStatus, Project, SessionView, TailscaleStatus } from '@minisumma/shared';
import { defaultNotificationPrefs, defaultSettings } from '@minisumma/shared';
import { describe, expect, it } from 'vitest';
import {
  countdown, diffCounts, formatBytes, hookSummary, installGuidance, lastSeenWords, NOTIFICATION_SWITCHES, parseDays, parseDiff, parsePartSize, partCountFor,
  previewMessage, pruneWords, quietSummary, quietUntil, resolveSection, runtimeWords, scopesInWords, SECTIONS, tailscaleFacts, TIME_RE,
} from '../../src/renderer/src/features/settings/model';
import { deriveSteps, doneCount, isComplete, nextStep } from '../../src/renderer/src/features/onboarding/model';
import type { StepFacts } from '../../src/renderer/src/features/onboarding/model';

const at = (iso: string) => new Date(iso);

describe('sections', () => {
  it('opens the first section for nothing or nonsense, and finds a section by id, label or an older name', () => {
    expect(resolveSection(null)).toBe('chatgpt');
    expect(resolveSection('nonsense')).toBe('chatgpt');
    expect(resolveSection('hooks')).toBe('hooks');
    expect(resolveSection('Claude hooks')).toBe('hooks');
    expect(resolveSection('Phone')).toBe('phones');
    expect(resolveSection('tailscale')).toBe('remote');
    expect(resolveSection('Data and privacy')).toBe('data');
    expect(SECTIONS.map((s) => s.id)).toEqual(['chatgpt', 'extension', 'claude-code', 'hooks', 'notifications', 'phones', 'remote', 'push', 'review', 'data', 'about']);
  });
});

describe('quiet mode', () => {
  const now = at('2026-10-30T14:10:00');
  it('computes the end of each choice, and none for "until I turn it off"', () => {
    expect(quietUntil('forever', now)).toBeNull();
    expect(Date.parse(quietUntil('1h', now) as string) - now.getTime()).toBe(3_600_000);
    expect(Date.parse(quietUntil('4h', now) as string) - now.getTime()).toBe(4 * 3_600_000);
    const morning = new Date(quietUntil('morning', now) as string);
    expect(morning.getHours()).toBe(8);
    expect(morning.getTime()).toBeGreaterThan(now.getTime());
    // Before 08:00 it means this morning; after, tomorrow's.
    expect(new Date(quietUntil('morning', at('2026-10-30T06:00:00')) as string).getDate()).toBe(30);
    expect(new Date(quietUntil('morning', at('2026-10-30T09:00:00')) as string).getDate()).toBe(31);
  });

  it('says in words when notifications are quiet', () => {
    const base = defaultSettings().notifications.quiet;
    expect(quietSummary(base, now.getTime())).toBe('Notifications are not silenced.');
    expect(quietSummary({ ...base, enabled: true, until: null }, now.getTime())).toBe('Quiet until you turn it off.');
    expect(quietSummary({ ...base, enabled: true, until: new Date(now.getTime() + 3_600_000).toISOString() }, now.getTime())).toMatch(/^Quiet until \d\d:\d\d\.$/);
    expect(quietSummary({ ...base, enabled: true, until: new Date(now.getTime() - 60_000).toISOString() }, now.getTime())).toBe('The quiet period you set has ended.');
    expect(quietSummary({ ...base, schedule: { enabled: true, from: '22:00', to: '08:00' } }, now.getTime())).toBe('Quiet every day from 22:00 to 08:00.');
  });

  it('accepts only 24 hour times', () => {
    for (const ok of ['00:00', '08:30', '22:00', '23:59']) expect(TIME_RE.test(ok)).toBe(true);
    for (const bad of ['', '8:30', '24:00', '12:60', '12:5', 'noon']) expect(TIME_RE.test(bad)).toBe(false);
  });
});

describe('the notification switches', () => {
  it('has one switch for every kind of notification the core knows, so that none can be on for everyone with no way to turn it off', () => {
    const kinds = Object.keys(defaultNotificationPrefs()).filter((k) => k !== 'enabled').sort();
    expect(NOTIFICATION_SWITCHES.map((s) => s.key).sort()).toEqual(kinds);
    // Each has a label, a short column name for the table, and one sentence of its own; the keys are not repeated.
    expect(new Set(NOTIFICATION_SWITCHES.map((s) => s.key)).size).toBe(NOTIFICATION_SWITCHES.length);
    for (const s of NOTIFICATION_SWITCHES) {
      expect(s.label.length).toBeGreaterThan(3);
      expect(s.column.length).toBeLessThanOrEqual(10); // the columns share one row of a table
      expect(s.description).toMatch(/\.$/);
    }
  });

  it('puts "Claude finished" right after the report, and says that a turn ending is not the task being complete', () => {
    const keys = NOTIFICATION_SWITCHES.map((s) => s.key);
    expect(keys.indexOf('turnEnded')).toBe(keys.indexOf('report') + 1);
    expect(NOTIFICATION_SWITCHES.find((s) => s.key === 'turnEnded')).toMatchObject({
      label: 'Claude finished', column: 'Finished', hint: true,
      description: 'A session stopped and is waiting for you, without a report. A turn ending does not mean the task is complete.',
    });
  });

  it('keeps every sentence free of the dashes the house rules refuse', () => {
    expect(NOTIFICATION_SWITCHES.map((s) => `${s.label} ${s.column} ${s.description}`).join(' ')).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('pairing', () => {
  it('counts down to the end of an offer and says expired after it', () => {
    const end = '2026-10-30T12:05:00.000Z';
    const t = Date.parse('2026-10-30T12:00:00.000Z');
    expect(countdown(end, t)).toEqual({ text: '5:00', expired: false });
    expect(countdown(end, t + 1000)).toEqual({ text: '4:59', expired: false });
    expect(countdown(end, t + 299_001)).toEqual({ text: '0:01', expired: false });
    expect(countdown(end, t + 300_000)).toEqual({ text: 'expired', expired: true });
    expect(countdown('not a date', t).expired).toBe(true);
  });

  it('describes what a device may do and when it was last seen', () => {
    expect(scopesInWords([])).toBe('No permissions');
    expect(scopesInWords(['read', 'notify', 'prompt'])).toBe('Read, notify, prompt');
    const ago = () => '3 min ago';
    expect(lastSeenWords({ lastSeenAt: null, lastSeenVia: null, revokedAt: null }, ago)).toBe('Not connected yet');
    expect(lastSeenWords({ lastSeenAt: 'x', lastSeenVia: 'tailscale', revokedAt: null }, ago)).toBe('Last seen 3 min ago over Tailscale');
    expect(lastSeenWords({ lastSeenAt: 'x', lastSeenVia: null, revokedAt: 'y' }, ago)).toBe('Revoked 3 min ago');
  });
});

describe('hooks', () => {
  const status = (over: Partial<HookStatus>): HookStatus => ({
    env: 'win', configDir: 'C:\\c', settingsPath: 'C:\\c\\settings.json', settingsExists: true, installed: false, events: [], missingEvents: ['Stop'], duplicateRegistrations: false,
    runtime: { command: 'node', kind: 'node', version: '22' }, captureScript: 'c.mjs', issues: [], ...over,
  });

  it('summarises an install honestly: partly, twice, fully, not at all', () => {
    expect(hookSummary(status({}))).toBe('Not installed');
    expect(hookSummary(status({ events: ['Stop'], missingEvents: ['Start', 'End'] }))).toBe('Partly installed: 2 events are missing');
    expect(hookSummary(status({ events: ['Stop'], missingEvents: ['End'] }))).toBe('Partly installed: 1 event is missing');
    expect(hookSummary(status({ installed: true, events: ['A', 'B'], missingEvents: [] }))).toBe('Installed for 2 events');
    expect(hookSummary(status({ installed: true, events: ['A'], missingEvents: [], duplicateRegistrations: true }))).toMatch(/Installed twice/);
  });

  it('words the runtime that runs the hooks', () => {
    expect(runtimeWords({ command: 'electron', kind: 'electron', version: '33' })).toContain('Node.js is not needed');
    expect(runtimeWords({ command: 'node', kind: 'node', version: '22.1' })).toBe('node, version 22.1');
    expect(runtimeWords({ command: '', kind: 'missing', version: null })).toContain('Hooks cannot run until Node.js is installed');
  });

  it('gives exact install commands per environment', () => {
    expect(installGuidance('win')[0]).toEqual({ where: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' });
    expect(installGuidance('wsl:Ubuntu')[0].command).toBe('curl -fsSL https://claude.ai/install.sh | bash');
    expect(installGuidance('win').at(-1)?.command).toBe('npm install -g @anthropic-ai/claude-code');
  });

  it('reads a unified diff line by line and counts what changes', () => {
    const lines = parseDiff('--- a\n+++ b\n@@ -1,2 +1,3 @@\n context\n-old\n+new\n+newer');
    expect(lines.map((l) => l.kind)).toEqual(['file', 'file', 'hunk', 'context', 'del', 'add', 'add']);
    expect(diffCounts(lines)).toEqual({ added: 2, removed: 1 });
    expect(parseDiff('')).toEqual([]);
  });
});

describe('tailscale', () => {
  const ts = (over: Partial<TailscaleStatus>): TailscaleStatus => ({
    installed: true, running: true, loggedIn: true, backendState: 'Running', hostName: 'pc', dnsName: 'pc.x.ts.net', tailnet: 'me@example.com', tailscaleIps: [],
    serve: { configured: false, url: null, target: null, funnelDetected: false }, checkedAt: '2026-10-30T12:00:00.000Z', problem: null, ...over,
  });
  it('states each fact in words', () => {
    expect(tailscaleFacts(ts({}))).toEqual({ installed: 'Installed', running: 'Running', signedIn: 'Signed in as me@example.com', serve: 'Not published' });
    expect(tailscaleFacts(ts({ installed: false }))).toMatchObject({ installed: 'Not installed', running: 'Not checked', signedIn: 'Not checked' });
    expect(tailscaleFacts(ts({ running: false, backendState: 'Stopped' })).running).toBe('Not running (Stopped)');
    expect(tailscaleFacts(ts({ loggedIn: false })).signedIn).toBe('Not signed in');
    expect(tailscaleFacts(ts({ serve: { configured: true, url: 'https://pc.x.ts.net', target: 'http://127.0.0.1:1', funnelDetected: false } })).serve).toBe('Published to your tailnet');
    expect(tailscaleFacts(ts({ serve: { configured: true, url: null, target: null, funnelDetected: true } })).serve).toBe('Funnel is on');
  });
});

describe('numbers and the review message', () => {
  it('formats sizes and counts', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1_480_000)).toBe('1.4 MB');
  });

  it('accepts whole numbers of days and sensible part sizes, and nothing else', () => {
    expect(parseDays('0')).toBe(0);
    expect(parseDays(' 90 ')).toBe(90);
    expect(parseDays('3650')).toBe(3650);
    for (const bad of ['', '-1', '1.5', 'abc', '3651', '99999']) expect(parseDays(bad)).toBeNull();
    expect(parsePartSize('12,000')).toBe(12000);
    expect(parsePartSize('2000')).toBe(2000);
    expect(parsePartSize('100 000')).toBe(100_000);
    for (const bad of ['1999', '100001', '', 'big']) expect(parsePartSize(bad)).toBeNull();
  });

  it('builds the preview with the real message builder, and leaves out what is switched off', () => {
    const base = { requestTemplate: 'Please review this.', includeSessionRef: true, projectName: 'GitManager', now: at('2026-10-30T10:00:00Z') };
    const on = previewMessage(base);
    expect(on).toContain('Project: GitManager');
    expect(on).toContain('Claude session: a1b2c3d4, managed, Windows, generation 1');
    expect(on).toContain('<<<MINI-SUMMA REPORT rpt_example0123456789 BEGIN>>>');
    expect(on.endsWith('Please review this.')).toBe(true);
    expect(previewMessage({ ...base, includeSessionRef: false })).not.toContain('Claude session:');
    expect(previewMessage({ ...base, requestTemplate: '   ' }).endsWith('<<<MINI-SUMMA REPORT rpt_example0123456789 END>>>')).toBe(true);
    expect(partCountFor(25_000, 12_000)).toBe(3);
    expect(partCountFor(10, 12_000)).toBe(1);
  });

  it('names what a cleanup removes and skips what it does not', () => {
    expect(pruneWords({ removed: { rawEvents: 0, activity: 0, notifications: 0, reports: 0, deliveries: 0 } })).toEqual({ total: 0, lines: [] });
    expect(pruneWords({ removed: { rawEvents: 1234, activity: 1, notifications: 0, reports: 2, deliveries: 2 } })).toEqual({
      total: 1239, lines: ['1,234 hook events', '1 activity entry', '2 reports', '2 handoff records'],
    });
  });
});

describe('the setup steps', () => {
  const env = (over: Partial<EnvironmentInfo> & { id: EnvironmentInfo['id'] }): EnvironmentInfo => ({
    label: 'Windows', available: true, claude: { path: 'C:\\claude.exe', version: '2.1.4', error: null }, node: { path: null, version: null }, configDir: null, hooks: null, notes: [], ...over,
  });
  const project = (id: string, name = id): Project => ({ id, name, roots: [{ id: `${id}_root`, projectId: id, env: 'win', path: 'C:\\Dev\\Project', label: null, position: 0 }] } as Project);
  const conversation = (projectId: string): Conversation => ({ id: `c_${projectId}`, projectId } as Conversation);
  const session = (origin: SessionView['origin']): SessionView => ({ key: 'win|x', origin } as unknown as SessionView);
  const hooks = (installed: boolean): HookStatus => ({
    env: 'win', configDir: '', settingsPath: '', settingsExists: true, installed, events: installed ? ['Stop'] : [], missingEvents: [], duplicateRegistrations: false,
    runtime: { command: 'node', kind: 'node', version: null }, captureScript: '', issues: [],
  });
  const view = (status: ChatGptViewState['status'], note: string | null = null): ChatGptViewState => ({ mode: 'embedded', status, url: null, title: null, canGoBack: false, canGoForward: false, note });
  const facts = (over: Partial<StepFacts> = {}): StepFacts => ({
    envs: [env({ id: 'win' })], envError: null, projects: [], conversations: [], sessions: [], hooks: [], settings: defaultSettings(), hasEmbeddedView: true, view: view('ready'), ...over,
  });
  const byId = (f: StepFacts) => Object.fromEntries(deriveSteps(f).map((s) => [s.id, s]));

  it('starts with only what is true: nothing but the machine itself', () => {
    const steps = deriveSteps(facts());
    expect(steps.map((s) => [s.id, s.done])).toEqual([['claude', true], ['project', false], ['conversation', false], ['chatgpt', true], ['hooks', false], ['session', false]]);
    expect(steps.find((s) => s.id === 'hooks')?.optional).toBe(true);
    expect(isComplete(steps)).toBe(false);
    expect(nextStep(steps)?.id).toBe('project');
    expect(doneCount(steps)).toEqual({ done: 2, total: 6 });
  });

  it('ticks Claude Code only when a reachable environment really has it', () => {
    expect(byId(facts({ envs: null })).claude).toMatchObject({ done: false, detail: 'Looking for Claude Code.' });
    expect(byId(facts({ envs: null, envError: 'Timed out.' })).claude.detail).toContain('Timed out.');
    expect(byId(facts({ envs: [env({ id: 'win', claude: { path: null, version: null, error: 'not in PATH' } })] })).claude.done).toBe(false);
    expect(byId(facts({ envs: [env({ id: 'win', available: false })] })).claude.done).toBe(false);
    expect(byId(facts({ envs: [env({ id: 'win' }), env({ id: 'wsl:Ubuntu', label: 'WSL (Ubuntu)', claude: { path: '/c', version: null, error: null } })] })).claude.detail).toBe('Found in Windows (version 2.1.4) and WSL (Ubuntu).');
  });

  it('ticks the project, its conversation and the session from what exists', () => {
    const f = facts({ projects: [project('p1', 'GitManager')], conversations: [conversation('p1')], sessions: [session('managed')] });
    const s = byId(f);
    expect(s.project).toMatchObject({ done: true, detail: 'GitManager.' });
    expect(s.conversation.done).toBe(true);
    expect(s.session.done).toBe(true);
    // A conversation of a project that is no longer active does not count, and an observed session is not one Mini-Summa started.
    const g = byId(facts({ projects: [project('p1')], conversations: [conversation('gone')], sessions: [session('external')] }));
    expect(g.conversation.done).toBe(false);
    expect(g.session.done).toBe(false);
    expect(g.conversation.detail).toContain('Paste the address');
  });

  it('says what to do first when there is no project yet', () => {
    const s = byId(facts());
    expect(s.conversation.detail).toBe('Create a project first.');
    expect(s.session.detail).toBe('Create a project first.');
  });

  it('reads how ChatGPT opens from the setting and the embedded view, and gives the sign-in note when it matters', () => {
    expect(byId(facts({ view: view('ready') })).chatgpt).toMatchObject({ done: true, detail: 'ChatGPT is loaded inside Mini-Summa.' });
    expect(byId(facts({ view: view('login_required') })).chatgpt.detail).toMatch(/Google sign-in is often refused/);
    expect(byId(facts({ view: view('login_required') })).chatgpt.done).toBe(false);
    expect(byId(facts({ view: view('challenge') })).chatgpt.detail).toMatch(/security check/);
    expect(byId(facts({ view: view('blocked', 'ChatGPT refused to open here.') })).chatgpt.detail).toBe('ChatGPT refused to open here.');
    expect(byId(facts({ view: null })).chatgpt.done).toBe(false);
    expect(byId(facts({ hasEmbeddedView: false, view: null })).chatgpt.detail).toMatch(/cannot show ChatGPT inside Mini-Summa/);
    const external = defaultSettings();
    external.chatgpt.mode = 'external';
    expect(byId(facts({ settings: external, view: null })).chatgpt).toMatchObject({ done: true, detail: 'ChatGPT opens in your browser.' });
    external.chatgpt.externalBrowser = 'extension';
    expect(byId(facts({ settings: external, view: null })).chatgpt.detail).toContain('extension');
  });

  it('treats hooks as optional: ticked when installed completely, never needed to finish', () => {
    expect(byId(facts({ hooks: [hooks(true)] })).hooks.done).toBe(true);
    expect(byId(facts({ hooks: [{ ...hooks(true), missingEvents: ['Stop'] }] })).hooks.done).toBe(false);
    const all = facts({ projects: [project('p1')], conversations: [conversation('p1')], sessions: [session('managed')] });
    expect(isComplete(deriveSteps(all))).toBe(true);
    expect(nextStep(deriveSteps(all))).toBeNull();
  });
});
