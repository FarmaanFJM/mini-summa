import { splitFences, toDisplayItems } from '../src/lib/fences';
import { formatExpiry, formatWhen, sessionMeta, sessionTarget, terminationLine } from '../src/lib/format';
import { describeApiError, isCleartextRemote, classifyNetworkError } from '../src/lib/errors';
import {
  activityTarget, conversationForReport, filterActivity, needsYouItems, NO_ACTIVITY_FILTER, projectCards, unassignedLiveSessions,
} from '../src/state/selectors';
import { ApiError, createInitialState } from '@minisumma/shared';
import type { ClientState } from '@minisumma/shared';
import {
  makeAction, makeActivity, makeConversation, makeDelivery, makeProject, makeSession, makeSummary, OTHER_KEY, SESSION_KEY,
} from './helpers/data';

describe('fences: the split is lossless', () => {
  it('keeps every byte for ordinary reports', () => {
    const body = 'Intro\n\n```ts\nconst a = 1;\n```\nMiddle `inline` text\n~~~\nraw\n~~~\nEnd';
    expect(splitFences(body).map((b) => b.raw).join('')).toBe(body);
    expect(splitFences(body).map((b) => b.kind)).toEqual(['text', 'code', 'text', 'code', 'text']);
  });

  it('shows a fenced block as code with its language and without the fences', () => {
    const [b] = splitFences('```bash\nnpm test\n```');
    expect(b).toMatchObject({ kind: 'code', lang: 'bash', text: 'npm test', closed: true });
  });

  it('treats an unclosed fence as code to the end, and does not mistake inline code for a fence', () => {
    const open = splitFences('before\n```\nnever closed\nstill code');
    expect(open[1]).toMatchObject({ kind: 'code', closed: false, text: 'never closed\nstill code' });
    expect(splitFences('```not a fence```').map((b) => b.kind)).toEqual(['text']);
  });

  it('a longer fence is only closed by an equal or longer fence', () => {
    const body = '````md\n```\ninner\n```\n````\nafter';
    const blocks = splitFences(body);
    expect(blocks[0]).toMatchObject({ kind: 'code', text: '```\ninner\n```' });
    expect(blocks[1].text).toBe('after');
  });

  it('survives Windows line endings and empty input', () => {
    const body = 'a\r\n```\r\ncode\r\n```\r\nb\r\n';
    expect(splitFences(body).map((b) => b.raw).join('')).toBe(body);
    expect(splitFences('')).toEqual([]);
  });

  it('is lossless for 2000 random mixes of fences, newlines and text', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const atoms = ['`', '``', '```', '~~~', '\n', '\r\n', ' ', 'a', 'bc', '```ts\n', '    ```\n'];
    for (let i = 0; i < 2000; i++) {
      const body = Array.from({ length: Math.floor(rnd() * 40) }, () => atoms[Math.floor(rnd() * atoms.length)]).join('');
      expect(splitFences(body).map((b) => b.raw).join('')).toBe(body);
    }
  });

  it('display chunks of a very long report add up to the same text', () => {
    const prose = Array.from({ length: 4000 }, (_, i) => `line ${i} with some words`).join('\n');
    const items = toDisplayItems(prose, 3000);
    expect(items.length).toBeGreaterThan(10);
    expect(items.every((i) => i.text.length <= 3000)).toBe(true);
    expect(items.map((i) => i.text).join('')).toBe(prose);
    const longLine = 'x'.repeat(10_000);
    expect(toDisplayItems(longLine, 3000).map((i) => i.text).join('')).toBe(longLine);
  });
});

describe('format', () => {
  const now = new Date(2026, 9, 30, 14, 40);
  it('formats times for people', () => {
    expect(formatWhen(new Date(2026, 9, 30, 9, 5), now)).toBe('09:05');
    expect(formatWhen(new Date(2026, 9, 29, 21, 5), now)).toBe('Yesterday 21:05');
    expect(formatWhen(new Date(2026, 8, 3, 9, 10), now)).toBe('3 Sep 09:10');
    expect(formatWhen(new Date(2025, 11, 25, 9, 10), now)).toBe('25 Dec 2025');
    expect(formatWhen('not a date', now)).toBe('');
    expect(formatWhen(null, now)).toBe('');
  });

  it('formats how long a request stays open', () => {
    expect(formatExpiry(new Date(now.getTime() + 12 * 60_000).toISOString(), now)).toBe('Expires in 12 min');
    expect(formatExpiry(new Date(now.getTime() + 3 * 3_600_000).toISOString(), now)).toBe('Expires in 3 h');
    expect(formatExpiry(new Date(now.getTime() - 1000).toISOString(), now)).toBe('Expired');
  });

  it('words suspected and observed termination differently', () => {
    expect(terminationLine(makeSession({ termination: { kind: 'suspected', reason: 'absent from the listing', at: null } }))).toMatch(/^May have ended\./);
    expect(terminationLine(makeSession({ termination: { kind: 'observed', reason: 'SessionEnd hook', at: null } }))).toBe('Ended: SessionEnd hook');
    expect(terminationLine(makeSession({ availability: 'ended' }))).toBe('Ended');
    expect(terminationLine(makeSession({ availability: 'disconnected' }))).toContain('may or may not still be running');
    expect(terminationLine(makeSession())).toBeNull();
  });

  it('identifies a session by project and short id and writes one plain metadata line', () => {
    expect(sessionTarget(makeSession())).toBe('GitManager, session a1b2c3d4');
    expect(sessionTarget(makeSession({ projectName: null }))).toBe('No project, session a1b2c3d4');
    expect(sessionMeta(makeSession({ origin: 'external', availability: 'resumable', stateLabel: 'Idle' }))).toBe('External · Resumable · Idle');
  });
});

describe('errors', () => {
  it('says what to do for each kind of failure', () => {
    expect(describeApiError(new ApiError(0, 'network', 'x'))).toContain('Your PC may be asleep, offline, or not signed in to Tailscale on this phone');
    expect(describeApiError(new ApiError(0, 'timeout', 'x'))).toContain('did not answer in time');
    expect(describeApiError(new ApiError(401, 'unauthorized', 'x'))).toBe('This phone was removed in Mini-Summa. Pair again.');
    expect(describeApiError(new ApiError(403, 'forbidden', 'x'))).toContain('not allowed');
    expect(describeApiError(new ApiError(503, 'unavailable', 'Warming up'))).toBe('Mini-Summa on your PC returned an error: Warming up');
  });

  it('recognises plain http to a remote device and certificate errors', () => {
    expect(isCleartextRemote('http://192.168.1.2:4317')).toBe(true);
    expect(isCleartextRemote('http://127.0.0.1:4317')).toBe(false);
    expect(isCleartextRemote('https://pc.ts.net')).toBe(false);
    expect(classifyNetworkError(new Error('java.security.cert.CertPathValidatorException: Trust anchor for certification path not found'), 'https://x')).toBe('tls');
    expect(classifyNetworkError(new ApiError(0, 'timeout', 'x'), 'https://x')).toBe('timeout');
    expect(classifyNetworkError(new Error('Network request failed'), 'https://x')).toBe('no_answer');
  });
});

describe('selectors', () => {
  const state = (over: Partial<ClientState> = {}): ClientState => ({ ...createInitialState(), loaded: true, projects: [makeProject()], sessions: [makeSession()], ...over });

  it('lists a permission request once, as the action that can be answered, not also as a waiting session', () => {
    const s = state({
      sessions: [makeSession({ attention: { kind: 'permission', since: null }, state: 'needs_permission' })],
      actions: [makeAction()],
    });
    const items = needsYouItems(s);
    expect(items.map((i) => i.kind)).toEqual(['action']);
    expect(items[0].subtitle).toBe('Bash: git push origin main');
  });

  it('lists sessions that wait for input and reports nobody has opened', () => {
    const s = state({
      sessions: [makeSession({ attention: { kind: 'input', since: null }, state: 'needs_input' })],
      reports: [makeSummary({ read: false }), makeSummary({ id: 'rep_2', read: true })],
    });
    expect(needsYouItems(s).map((i) => i.kind)).toEqual(['session', 'report']);
  });

  it('builds project cards with live session counts and an attention marker', () => {
    const s = state({
      projects: [makeProject({ id: 'a', name: 'Alpha', sortOrder: 1 }), makeProject({ id: 'b', name: 'Beta', sortOrder: 0 }), makeProject({ id: 'c', archivedAt: '2026-01-01T00:00:00Z' })],
      sessions: [
        makeSession({ key: SESSION_KEY, projectId: 'a', availability: 'live', attention: { kind: 'error', since: null } }),
        makeSession({ key: OTHER_KEY, projectId: 'a', availability: 'resumable' }),
      ],
      reports: [makeSummary({ projectId: 'a', read: false })],
    });
    const cards = projectCards(s);
    expect(cards.map((c) => c.project.name)).toEqual(['Beta', 'Alpha']);
    expect(cards[1]).toMatchObject({ liveSessions: 1, needsYou: true, unreadReports: 1 });
    expect(cards[0]).toMatchObject({ liveSessions: 0, needsYou: false });
  });

  it('shows live sessions that belong to no project', () => {
    expect(unassignedLiveSessions(state({ sessions: [makeSession({ projectId: null, projectName: null })] }))).toHaveLength(1);
  });

  it('filters activity by needs action, unread and project', () => {
    const list = [
      makeActivity({ id: '1' }),
      makeActivity({ id: '2', requiresAction: true, resolvedAt: '2026-10-30T10:00:00Z', read: true }),
      makeActivity({ id: '3', projectId: 'prj_2', requiresAction: false, read: true }),
    ];
    expect(filterActivity(list, NO_ACTIVITY_FILTER)).toHaveLength(3);
    expect(filterActivity(list, { ...NO_ACTIVITY_FILTER, needsAction: true }).map((a) => a.id)).toEqual(['1']);
    expect(filterActivity(list, { ...NO_ACTIVITY_FILTER, unread: true }).map((a) => a.id)).toEqual(['1']);
    expect(filterActivity(list, { ...NO_ACTIVITY_FILTER, projectId: 'prj_2' }).map((a) => a.id)).toEqual(['3']);
  });

  it('opens the most specific thing an activity entry links to', () => {
    const s = state({ deliveries: [makeDelivery({ id: 'dlv_9', reportId: 'rep_9' })] });
    expect(activityTarget(makeActivity({ links: [{ kind: 'project', id: 'prj_1' }, { kind: 'report', id: 'rep_1' }] }), s)).toEqual({ pathname: '/report', params: { id: 'rep_1' } });
    expect(activityTarget(makeActivity({ links: [{ kind: 'delivery', id: 'dlv_9' }] }), s)).toEqual({ pathname: '/report', params: { id: 'rep_9' } });
    expect(activityTarget(makeActivity({ links: [{ kind: 'session', key: SESSION_KEY }] }), s)).toEqual({ pathname: '/session', params: { key: SESSION_KEY } });
    expect(activityTarget(makeActivity({ links: [{ kind: 'action', id: 'act_1' }] }), s)).toBe('/inbox');
    expect(activityTarget(makeActivity({ links: [{ kind: 'settings', section: 'hooks' }] }), s)).toBeNull();
  });

  it('chooses the conversation for a report: frozen destination first, then the preferred one, never anything else', () => {
    const conv = makeConversation({ id: 'cnv_1' });
    const s = state({ conversations: [conv], projects: [makeProject({ preferredConversationId: 'cnv_1' })], deliveries: [makeDelivery({ reportId: 'rep_1' })] });
    expect(conversationForReport(s, { id: 'rep_1', projectId: 'prj_1' })?.source).toBe('delivery');
    const noDest = state({ conversations: [conv], projects: [makeProject({ preferredConversationId: 'cnv_1' })], deliveries: [makeDelivery({ destination: null })] });
    expect(conversationForReport(noDest, { id: 'rep_1', projectId: 'prj_1' })).toMatchObject({ source: 'project', url: conv.url });
    const nothing = state({ conversations: [conv], projects: [makeProject({ preferredConversationId: null })] });
    expect(conversationForReport(nothing, { id: 'rep_1', projectId: 'prj_1' })).toBeNull();
  });
});
