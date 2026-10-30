import type { PendingAction, SessionKey, SessionView } from '@minisumma/shared';
import { describe, expect, it } from 'vitest';
import { createSeed, IDS } from '../../src/renderer/src/dev/demo/seed';
import { nextStartingMarks } from '../../src/renderer/src/app/uiStore';
import {
  canOfferTyping, describeInputTarget, dotTone, formatRelative, isStartingUp, noticeFor, originAndEnv, shortId, STARTING_HINT, STARTING_HINT_AFTER_MS,
  tabTitle, waitingFor,
} from '../../src/renderer/src/features/workspace/sessionModel';
import { endsTerminalsNote, runningTerminalsIn } from '../../src/renderer/src/features/shell/ProjectList';
import {
  closeTab, emptyTabs, openTab, replaceTab, selectionAfterClose, visibleTabs, withAutoTabs,
} from '../../src/renderer/src/features/workspace/tabs';

const seed = () => createSeed(new Date('2026-10-30T10:00:00Z'));
const find = (key: string): SessionView => {
  const s = seed().sessions.find((x) => x.key === key);
  if (!s) throw new Error(`no session ${key}`);
  return s;
};

describe('the "Input goes to" statement', () => {
  it('names project, session, origin and environment for a live managed session', () => {
    const t = describeInputTarget(find(IDS.s.gmWorking), 'GitManager', true);
    expect(t.kind).toBe('managed');
    expect(t.text).toBe('Input goes to: GitManager / Session a1b2c3d4 (managed, Windows)');
  });

  it('says WSL distributions by name', () => {
    expect(describeInputTarget(find(IDS.s.atlasIdle), 'Atlas API', true).text).toBe('Input goes to: Atlas API / Session e1f2a3b4 (managed, WSL (Ubuntu))');
  });

  it('never claims input for an observed session and says why', () => {
    const t = describeInputTarget(find(IDS.s.gmExternal), 'GitManager', true);
    expect(t.kind).toBe('observed');
    expect(t.text).toContain('No input');
    expect(t.text).toContain('(external, Windows) is observed');
    expect(t.text).toContain('cannot type into it');
    expect(t.text).not.toContain('Input goes to');
  });

  it('treats background sessions as observed too', () => {
    expect(describeInputTarget(find(IDS.s.dashBackground), 'Trading dashboard', true).kind).toBe('observed');
  });

  it('says a managed session that is not running takes no input', () => {
    for (const key of [IDS.s.atlasResumable, IDS.s.docsDisconnected, IDS.s.dashFailed]) {
      const t = describeInputTarget(find(key), 'Project', true);
      expect(t.kind).toBe('not_running');
      expect(t.text).toContain('is not running');
    }
  });

  it('says input is paused, and where it would go, while the connection is down', () => {
    const t = describeInputTarget(find(IDS.s.gmWorking), 'GitManager', false);
    expect(t.kind).toBe('paused');
    expect(t.text).toContain('paused');
    expect(t.text).toContain('GitManager / Session a1b2c3d4');
  });

  it('does not invent a project for an unassigned session', () => {
    expect(describeInputTarget(find(IDS.s.unassigned), null, true).text).toContain('No project / Session 7c6b5a49');
  });

  it('helpers agree with the banner', () => {
    const s = find(IDS.s.gmWorking);
    expect(shortId(s)).toBe('a1b2c3d4');
    expect(originAndEnv(s)).toBe('managed, Windows');
    expect(tabTitle(s)).toBe('Session a1b2c3d4, managed, Windows. Working.');
  });
});

describe('state tones', () => {
  it('maps states to a small set of tones', () => {
    expect(dotTone(find(IDS.s.gmWorking))).toBe('busy');
    expect(dotTone(find(IDS.s.gmPermission))).toBe('attention');
    expect(dotTone(find(IDS.s.gmExternal))).toBe('idle');
    expect(dotTone(find(IDS.s.dashFailed))).toBe('error');
    expect(dotTone(find(IDS.s.docsDisconnected))).toBe('off');
    expect(dotTone(find(IDS.s.atlasResumable))).toBe('off');
  });
});

describe('notices', () => {
  const permission: PendingAction[] = seed().actions;

  it('says what Claude is waiting for, using the pending request when there is one', () => {
    expect(waitingFor(find(IDS.s.gmPermission), permission)).toBe('Claude is asking for permission: Bash: rm -rf node_modules && npm ci. Answer it in the terminal.');
    expect(waitingFor(find(IDS.s.gmPermission), [])).toBe('Claude is asking for permission. Answer it in the terminal.');
    expect(waitingFor(find(IDS.s.gmWorking), permission)).toBeNull();
  });

  it('gives a live managed session in a plain state no notice', () => {
    expect(noticeFor(find(IDS.s.gmWorking), [])).toBeNull();
    expect(noticeFor(find(IDS.s.gmPermission), permission)?.tone).toBe('attention');
  });

  it('explains a disconnected session and offers resume only when it can be resumed', () => {
    const n = noticeFor(find(IDS.s.docsDisconnected), []);
    expect(n?.text).toContain('lost its connection');
    expect(n?.canResume).toBe(true);
    expect(noticeFor({ ...find(IDS.s.docsDisconnected), resumable: false }, [])?.canResume).toBe(false);
  });

  it('reports how an ended session ended, and marks a guess as a guess', () => {
    expect(noticeFor(find(IDS.s.atlasResumable), [])?.text).toBe('This session ended: The session ended (SessionEnd hook).');
    const failed = noticeFor(find(IDS.s.dashFailed), []);
    expect(failed?.tone).toBe('error');
    expect(failed?.canResume).toBe(false);
    const guess = noticeFor({ ...find(IDS.s.atlasResumable), termination: { kind: 'suspected', reason: 'Not in the session list', at: null } }, []);
    expect(guess?.text).toContain('This is a guess');
  });

  it('has no notice for observed sessions (their panel explains itself)', () => {
    expect(noticeFor(find(IDS.s.gmExternal), [])).toBeNull();
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  it('uses the units people use', () => {
    expect(formatRelative('2026-10-30T11:59:50Z', now)).toBe('just now');
    expect(formatRelative('2026-10-30T11:46:00Z', now)).toBe('14 min ago');
    expect(formatRelative('2026-10-30T09:00:00Z', now)).toBe('3 h ago');
    expect(formatRelative('2026-10-29T10:00:00Z', now)).toBe('yesterday');
    expect(formatRelative('2026-10-20T12:00:00Z', now)).toBe('10 days ago');
    expect(formatRelative(null, now)).toBe('');
    expect(formatRelative('not a date', now)).toBe('');
  });
});

describe('session tabs', () => {
  const sessions = seed().sessions;

  it('opens a tab for each live managed session of a project, and none for observed ones', () => {
    const model = withAutoTabs(emptyTabs(), sessions);
    expect(model.openTabs[IDS.gitManager]).toEqual([IDS.s.gmWorking, IDS.s.gmPermission]);
    expect(model.openTabs[IDS.atlas]).toEqual([IDS.s.atlasIdle]);
  });

  it('also opens a tab for a managed session that ended with an error, so the person sees it', () => {
    const model = withAutoTabs(emptyTabs(), sessions);
    expect(model.openTabs[IDS.dashboard]).toEqual([IDS.s.dashFailed]);
  });

  it('also opens a tab for a managed session whose terminal was lost, so the person can decide what to do', () => {
    const model = withAutoTabs(emptyTabs(), sessions);
    expect(model.openTabs[IDS.docs]).toEqual([IDS.s.docsDisconnected]);
  });

  it('does not open a tab by itself for a session that ended quietly', () => {
    const model = withAutoTabs(emptyTabs(), sessions);
    expect(model.openTabs[IDS.atlas]).not.toContain(IDS.s.atlasResumable);
  });

  it('shows managed live sessions first, then other managed ones, then observed ones', () => {
    let model = withAutoTabs(emptyTabs(), sessions);
    model = openTab(model, IDS.gitManager, IDS.s.gmExternal as SessionKey);
    const tabs = visibleTabs(model, IDS.gitManager, sessions);
    expect(tabs.map((s) => s.key)).toEqual([IDS.s.gmWorking, IDS.s.gmPermission, IDS.s.gmExternal]);
    // An ended managed session opened afterwards sorts before the observed one.
    const withEnded = openTab(model, IDS.gitManager, IDS.s.atlasResumable as SessionKey);
    expect(visibleTabs(withEnded, IDS.gitManager, sessions).map((s) => s.key)).toEqual([IDS.s.gmWorking, IDS.s.gmPermission, IDS.s.gmExternal]);
  });

  it('closing a tab hides the view and keeps a live session from reopening by itself', () => {
    let model = withAutoTabs(emptyTabs(), sessions);
    model = closeTab(model, IDS.gitManager, IDS.s.gmWorking as SessionKey);
    expect(visibleTabs(model, IDS.gitManager, sessions).map((s) => s.key)).toEqual([IDS.s.gmPermission]);
    expect(withAutoTabs(model, sessions).openTabs[IDS.gitManager]).toEqual([IDS.s.gmPermission]);
    // Opening it again on purpose brings it back.
    model = openTab(model, IDS.gitManager, IDS.s.gmWorking as SessionKey);
    expect(model.dismissed).not.toContain(IDS.s.gmWorking);
    expect(visibleTabs(model, IDS.gitManager, sessions).map((s) => s.key)).toContain(IDS.s.gmWorking);
  });

  it('never shows a session that belongs to another project', () => {
    const model = openTab(withAutoTabs(emptyTabs(), sessions), IDS.docs, IDS.s.gmWorking as SessionKey);
    expect(visibleTabs(model, IDS.docs, sessions).map((s) => s.key)).toEqual([IDS.s.docsDisconnected]); // its own, not the GitManager one
  });

  it('shows an unassigned session opened from this project', () => {
    const model = openTab(emptyTabs(), IDS.docs, IDS.s.unassigned as SessionKey);
    expect(visibleTabs(model, IDS.docs, sessions).map((s) => s.key)).toEqual([IDS.s.unassigned]);
  });

  it('a resumed session takes the place of the one it continues', () => {
    const start = openTab(openTab(emptyTabs(), IDS.atlas, IDS.s.atlasIdle as SessionKey), IDS.atlas, IDS.s.atlasResumable as SessionKey);
    const model = replaceTab(start, IDS.atlas, IDS.s.atlasResumable as SessionKey, 'wsl:Ubuntu|new-session' as SessionKey);
    expect(model.openTabs[IDS.atlas]).toEqual([IDS.s.atlasIdle, 'wsl:Ubuntu|new-session']);
  });

  it('picks the neighbour on the left after closing, else the right, else nothing', () => {
    const tabs = [find(IDS.s.gmWorking), find(IDS.s.gmPermission), find(IDS.s.gmExternal)];
    expect(selectionAfterClose(tabs, tabs[1].key)).toBe(tabs[0].key);
    expect(selectionAfterClose(tabs, tabs[0].key)).toBe(tabs[1].key);
    expect(selectionAfterClose([tabs[0]], tabs[0].key)).toBeNull();
  });
});

describe('a terminal that is still starting', () => {
  const starting = (over: Partial<SessionView> = {}): SessionView => ({
    ...find(IDS.s.atlasIdle), state: 'unknown', stateLabel: 'Starting', attention: null, startedAt: '2026-10-30T10:00:00.000Z', ...over,
  });

  it('is a managed, running terminal with no state yet, and nothing else', () => {
    expect(isStartingUp(starting())).toBe(true);
    expect(isStartingUp(starting({ availability: 'resumable' }))).toBe(false);
    expect(isStartingUp(starting({ availability: 'disconnected' }))).toBe(false);
    expect(isStartingUp(starting({ origin: 'external' }))).toBe(false);
    expect(isStartingUp(find(IDS.s.gmWorking))).toBe(false);
  });

  it('points to the terminal after six seconds, in the architect\'s words', () => {
    expect(STARTING_HINT_AFTER_MS).toBe(6000);
    expect(STARTING_HINT).toBe('Claude may be waiting for you to answer a question in the terminal, such as whether you trust this folder.');
    expect(STARTING_HINT).not.toMatch(/\u2014|\u2013/);
  });

  it('gets no notice of its own from the model: the hint is about time, which the component owns', () => {
    expect(noticeFor(starting(), [])).toBeNull();
  });

  it('is shown as having no state: a quiet dot, not busy and not idle', () => {
    expect(dotTone(starting())).toBe('off');
  });

  it('gets no offer to type for the person, in any form', () => {
    expect(canOfferTyping(starting())).toBe(false);
    // The same session once it has a state may be offered typing.
    expect(canOfferTyping(starting({ state: 'waiting_for_you' }))).toBe(true);
    expect(canOfferTyping(find(IDS.s.gmWorking))).toBe(true);
  });

  it('is never offered typing when it is observed, not running, or gone', () => {
    expect(canOfferTyping(find(IDS.s.gmExternal))).toBe(false);
    expect(canOfferTyping(find(IDS.s.dashBackground))).toBe(false);
    expect(canOfferTyping(find(IDS.s.atlasResumable))).toBe(false);
    expect(canOfferTyping(find(IDS.s.docsDisconnected))).toBe(false);
    expect(canOfferTyping(find(IDS.s.dashFailed))).toBe(false);
    expect(canOfferTyping(starting({ state: 'presence_lost' }))).toBe(false);
  });
});

describe('when a terminal was first seen starting', () => {
  const starting = (key: string, startedAt: string | null): SessionView => ({ ...find(IDS.s.atlasIdle), key: key as SessionKey, state: 'unknown', startedAt });

  it('marks a terminal the first time it is seen starting, and only that one', () => {
    const marks = nextStartingMarks({}, [starting('a', 't1'), find(IDS.s.gmWorking)], 1000);
    expect(marks).toEqual({ a: { since: 1000, run: 't1' } });
  });

  it('keeps the first moment while the same run is still starting, and returns the same object when nothing changed', () => {
    const first = nextStartingMarks({}, [starting('a', 't1')], 1000);
    const again = nextStartingMarks(first, [starting('a', 't1')], 9000);
    expect(again).toBe(first);
  });

  it('starts again for a new run of the same session (a resume writes a new start time)', () => {
    const first = nextStartingMarks({}, [starting('a', 't1')], 1000);
    expect(nextStartingMarks(first, [starting('a', 't2')], 5000)).toEqual({ a: { since: 5000, run: 't2' } });
  });

  it('forgets a terminal as soon as it has a state, or is gone', () => {
    const first = nextStartingMarks({}, [starting('a', 't1'), starting('b', 't1')], 1000);
    const next = nextStartingMarks(first, [{ ...starting('a', 't1'), state: 'idle' }, starting('b', 't1')], 2000);
    expect(Object.keys(next)).toEqual(['b']);
    expect(nextStartingMarks(next, [], 3000)).toEqual({});
  });
});

describe('removing a project with running terminals', () => {
  it('reads the number of terminals from the core\'s refusal, and ignores every other error', () => {
    expect(runningTerminalsIn({ code: 'sessions_running', details: { sessions: ['a', 'b'] } })).toBe(2);
    expect(runningTerminalsIn({ code: 'sessions_running' })).toBe(1);
    expect(runningTerminalsIn({ code: 'conflict', details: { sessions: ['a'] } })).toBeNull();
    expect(runningTerminalsIn(new Error('boom'))).toBeNull();
    expect(runningTerminalsIn(null)).toBeNull();
  });

  it('says plainly that the terminals end and can be resumed', () => {
    expect(endsTerminalsNote(0)).toBe('');
    expect(endsTerminalsNote(1)).toBe(' Removing it also ends its running Claude terminal. You can resume the session later.');
    expect(endsTerminalsNote(3)).toBe(' Removing it also ends its 3 running Claude terminals. You can resume the sessions later.');
  });
});
