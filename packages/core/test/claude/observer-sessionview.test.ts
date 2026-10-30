import { describe, expect, it } from 'vitest';
import type { GenerationPhase } from '@minisumma/claude-integration';
import type { SessionState, SessionView } from '@minisumma/shared';
import type { ManagedSessionRecord } from '../../src/contracts.ts';
import type { Attribution, SessionFacts } from '../../src/claude/projection.ts';
import { EXTERNAL_REMOTE_CONTROL_HINT, buildSessionView, labelOf } from '../../src/claude/sessionView.ts';
import type { ReducerFields, SessionViewInput } from '../../src/claude/sessionView.ts';

const SID = '11111111-1111-4111-8111-111111111111';
const KEY = `posix|${SID}` as const;

interface R {
  state?: SessionState; evidence?: string; cwd?: string | null; hookSeen?: boolean; kind?: string | null; pid?: number | null; phase?: GenerationPhase | 'none';
  n?: number; proc?: { pid: number | null; startedAt: number | null } | null; term?: 'hook_session_end' | 'process_exit' | 'absent_from_snapshot' | null;
  unresolved?: number; prompted?: boolean;
}
const reducer = (o: R = {}): ReducerFields => ({
  state: o.state ?? 'idle', evidence: o.evidence ?? 'hook:SessionStart', cwd: o.cwd === undefined ? '/w/proj' : o.cwd, hook_seen: o.hookSeen ?? true,
  observed: o.kind === undefined && o.pid === undefined ? null : { status: null, waitingFor: null, kind: o.kind ?? 'interactive', pid: o.pid ?? null },
  gen: {
    n: o.n ?? 1, phase: (o.phase ?? 'live') as ReducerFields['gen']['phase'], proc: o.proc === undefined ? null : o.proc,
    start: null, open: null,
    term: o.term === undefined || o.term === null ? null : (o.term === 'hook_session_end'
      ? { kind: 'hook_session_end', marker: { tid: null, env: 'posix', domain: null, mono: null }, seq: 9 }
      : o.term === 'process_exit' ? { kind: 'process_exit', snapshot_seq: 8, seq: 9 } : { kind: 'absent_from_snapshot', snapshot_seq: 8, seq: 9 }),
  },
  unresolved: Array.from({ length: o.unresolved ?? 0 }, (_, i) => ({ seq: i, hook_event: 'Stop', relation: 'uncertain' as const, why: 'x' })),
  tasks: new Map(o.prompted ? [['k:p', { prompt_id: 'p', started_seq: 1 }]] : []),
  current_prompt_id: o.prompted ? 'p' : null,
});

const managed = (o: Partial<ManagedSessionRecord> = {}): ManagedSessionRecord => ({
  key: KEY, env: 'posix', sessionId: SID, projectId: 'p1', rootId: 'r1', cwd: '/w/proj', name: null, mode: 'new', resumedFrom: null, remoteControl: false,
  status: 'running', pid: 4321, startedAt: '2026-01-01T10:00:00.000Z', exitedAt: null, exitCode: null, exitSignal: null, exitReason: null, cols: 120, rows: 32,
  prompted: false, lastOutputAt: null, appRunId: 'run', conversationId: null, ...o,
});

const facts = (o: Partial<SessionFacts> = {}): SessionFacts => ({
  firstAt: null, lastHookAt: null, startedAtHook: null, name: null, sessionEndReason: null, stateSince: null, abnormalEnd: false, endedAt: null, ...o,
});

const attribution = (o: Partial<Attribution> = {}): Attribution => ({ projectId: 'p1', projectName: 'Proj', resolution: 'matched', ...o });

function build(over: Partial<SessionViewInput> = {}): SessionView {
  const view = buildSessionView({
    key: KEY, env: 'posix', sessionId: SID, reducer: null, facts: null, managed: null, attribution: attribution(), projectDefaultKey: null, history: null, ...over,
  });
  if (!view) throw new Error('no view');
  return view;
}

describe('origin', () => {
  it('managed when a managed record exists, whatever else is known', () => {
    expect(build({ managed: managed(), reducer: reducer({ kind: 'background' }) }).origin).toBe('managed');
  });
  it('background when discovery says so and Mini-Summa did not start it', () => {
    expect(build({ reducer: reducer({ kind: 'background' }) }).origin).toBe('background');
  });
  it('external otherwise, also when only hooks were seen', () => {
    expect(build({ reducer: reducer({ kind: 'interactive' }) }).origin).toBe('external');
    expect(build({ reducer: reducer() }).origin).toBe('external');
  });
});

/** Every combination of origin, evidence and availability the rules name, with the termination kind that goes with it. */
interface Row {
  name: string;
  input: Partial<SessionViewInput>;
  expect: { origin: SessionView['origin']; availability: SessionView['availability']; resumable: boolean; termination: 'none' | 'observed' | 'suspected' };
}
const rows: Row[] = [
  { name: 'managed, terminal running', input: { managed: managed() }, expect: { origin: 'managed', availability: 'live', resumable: false, termination: 'none' } },
  { name: 'managed, terminal running, reducer saw a prompt', input: { managed: managed(), reducer: reducer({ prompted: true }) }, expect: { origin: 'managed', availability: 'live', resumable: false, termination: 'none' } },
  { name: 'managed, exited, record says prompted', input: { managed: managed({ status: 'exited', prompted: true, exitedAt: '2026-01-01T11:00:00.000Z', exitCode: 0 }) }, expect: { origin: 'managed', availability: 'resumable', resumable: true, termination: 'observed' } },
  { name: 'managed, exited, only the reducer saw a prompt', input: { managed: managed({ status: 'exited', exitedAt: 'x', exitCode: 0 }), reducer: reducer({ prompted: true }) }, expect: { origin: 'managed', availability: 'resumable', resumable: true, termination: 'observed' } },
  { name: 'managed, exited, never prompted', input: { managed: managed({ status: 'exited', exitedAt: 'x', exitCode: 1 }) }, expect: { origin: 'managed', availability: 'ended', resumable: false, termination: 'observed' } },
  { name: 'managed, exited, never prompted, with a reducer that saw hooks but no prompt', input: { managed: managed({ status: 'exited', exitedAt: 'x', exitCode: 1 }), reducer: reducer() }, expect: { origin: 'managed', availability: 'ended', resumable: false, termination: 'observed' } },
  { name: 'managed, link lost, prompted', input: { managed: managed({ status: 'disconnected', prompted: true, pid: null, exitReason: 'app_restart' }) }, expect: { origin: 'managed', availability: 'disconnected', resumable: true, termination: 'none' } },
  { name: 'managed, link lost, never prompted', input: { managed: managed({ status: 'disconnected', pid: null }) }, expect: { origin: 'managed', availability: 'disconnected', resumable: false, termination: 'none' } },
  { name: 'managed, link lost, and Claude Code stopped listing it', input: { managed: managed({ status: 'disconnected', prompted: true }), reducer: reducer({ phase: 'lost_suspected', state: 'presence_lost', term: 'absent_from_snapshot' }) }, expect: { origin: 'managed', availability: 'disconnected', resumable: true, termination: 'suspected' } },
  { name: 'managed, link lost, and a SessionEnd hook was seen', input: { managed: managed({ status: 'disconnected', prompted: true }), reducer: reducer({ phase: 'ended_observed', state: 'ended', term: 'hook_session_end' }) }, expect: { origin: 'managed', availability: 'disconnected', resumable: true, termination: 'observed' } },
  { name: 'external, generation live', input: { reducer: reducer() }, expect: { origin: 'external', availability: 'live', resumable: false, termination: 'none' } },
  { name: 'external, absent from a full listing, with a prompt', input: { reducer: reducer({ phase: 'lost_suspected', state: 'presence_lost', term: 'absent_from_snapshot', prompted: true }) }, expect: { origin: 'external', availability: 'disconnected', resumable: true, termination: 'suspected' } },
  { name: 'external, absent from a full listing, never prompted', input: { reducer: reducer({ phase: 'lost_suspected', state: 'presence_lost', term: 'absent_from_snapshot' }) }, expect: { origin: 'external', availability: 'disconnected', resumable: false, termination: 'suspected' } },
  { name: 'external, SessionEnd seen, with a prompt', input: { reducer: reducer({ phase: 'ended_observed', state: 'ended', term: 'hook_session_end', prompted: true }) }, expect: { origin: 'external', availability: 'ended', resumable: true, termination: 'observed' } },
  { name: 'external, SessionEnd seen, never prompted', input: { reducer: reducer({ phase: 'ended_observed', state: 'ended', term: 'hook_session_end' }) }, expect: { origin: 'external', availability: 'ended', resumable: false, termination: 'observed' } },
  { name: 'external, process verifiably dead on this host', input: { reducer: reducer({ phase: 'ended_observed', state: 'ended', term: 'process_exit', prompted: true }) }, expect: { origin: 'external', availability: 'ended', resumable: true, termination: 'observed' } },
  { name: 'external, listed but its pid was already dead when first seen', input: { reducer: reducer({ phase: 'none', n: 0, state: 'unknown', evidence: 'none', hookSeen: false }) }, expect: { origin: 'external', availability: 'ended', resumable: false, termination: 'observed' } },
  { name: 'background, generation live', input: { reducer: reducer({ kind: 'background' }) }, expect: { origin: 'background', availability: 'live', resumable: false, termination: 'none' } },
  { name: 'background, absent from a full listing', input: { reducer: reducer({ kind: 'background', phase: 'lost_suspected', state: 'presence_lost', term: 'absent_from_snapshot' }) }, expect: { origin: 'background', availability: 'disconnected', resumable: false, termination: 'suspected' } },
  { name: 'background, process dead', input: { reducer: reducer({ kind: 'background', phase: 'ended_observed', state: 'ended', term: 'process_exit' }) }, expect: { origin: 'background', availability: 'ended', resumable: false, termination: 'observed' } },
];

describe('origin x availability x termination (every combination the rules name)', () => {
  it.each(rows)('$name', (row) => {
    const v = build(row.input);
    expect({ origin: v.origin, availability: v.availability, resumable: v.resumable, termination: v.termination?.kind ?? 'none' }).toEqual(row.expect);
  });

  it('never presents a suspected end as observed, nor an observed end as suspected', () => {
    for (const row of rows) {
      const v = build(row.input);
      const phase = row.input.reducer?.gen.phase ?? null;
      const terminalExit = row.input.managed?.status === 'exited';
      // suspected only ever means "absent from a full listing", and never covers a terminal exit Mini-Summa saw itself
      if (v.termination?.kind === 'suspected') {
        expect(phase, row.name).toBe('lost_suspected');
        expect(terminalExit, row.name).toBe(false);
      }
      // observed only ever means a terminal exit, a SessionEnd hook, or a pid verifiably dead on this host
      if (v.termination?.kind === 'observed') expect(terminalExit || phase === 'ended_observed' || phase === 'none', row.name).toBe(true);
      // and a suspected loss is never turned into an observed one
      if (phase === 'lost_suspected' && !terminalExit) expect(v.termination?.kind, row.name).toBe('suspected');
    }
  });

  it('a suspected loss says it may be wrong; an observed end says what was seen', () => {
    const suspected = build({ reducer: reducer({ phase: 'lost_suspected', state: 'presence_lost', term: 'absent_from_snapshot' }), facts: facts({ endedAt: '2026-01-01T10:05:00.000Z' }) });
    expect(suspected.termination).toEqual({ kind: 'suspected', reason: 'Claude Code no longer lists this session. It may have ended, or the listing may be incomplete.', at: '2026-01-01T10:05:00.000Z' });
    const hook = build({ reducer: reducer({ phase: 'ended_observed', state: 'ended', term: 'hook_session_end' }), facts: facts({ sessionEndReason: 'prompt_input_exit', endedAt: 'T' }) });
    expect(hook.termination).toEqual({ kind: 'observed', reason: 'The session was closed from inside Claude Code.', at: 'T' });
    const dead = build({ reducer: reducer({ phase: 'ended_observed', state: 'ended', term: 'process_exit' }) });
    expect(dead.termination?.reason).toBe('The Claude process is no longer running.');
  });

  it.each([
    ['prompt_input_exit', 'The session was closed from inside Claude Code.'], ['clear', 'The conversation was cleared with /clear.'],
    ['logout', 'You logged out of Claude Code.'], ['other', 'The session ended.'], ['brand_new_reason', 'The session ended (brand_new_reason).'], [null, 'The session ended.'],
  ])('puts the SessionEnd reason %s into words', (reason, text) => {
    const v = build({ reducer: reducer({ phase: 'ended_observed', state: 'ended', term: 'hook_session_end' }), facts: facts({ sessionEndReason: reason }) });
    expect(v.termination?.reason).toBe(text);
  });
});

describe('a managed terminal', () => {
  it('with no hook yet is "unknown", labelled Starting, with its evidence being the terminal itself', () => {
    const v = build({ managed: managed() });
    expect(v).toMatchObject({ state: 'unknown', stateLabel: 'Starting', stateEvidence: 'managed:pty', generation: 1, pid: 4321, attention: null, unresolvedOrdering: 0 });
  });

  it('takes its state from the reducer once hooks arrive', () => {
    const v = build({ managed: managed(), reducer: reducer({ state: 'working', evidence: 'hook:UserPromptSubmit' }), facts: facts({ lastHookAt: 'T' }) });
    expect(v).toMatchObject({ state: 'working', stateLabel: 'Working', stateEvidence: 'hook:UserPromptSubmit', generation: 1 });
  });

  it('uses what discovery observed when it is all there is (and says it was observed only)', () => {
    const v = build({ managed: managed(), reducer: reducer({ state: 'idle', evidence: 'discovery', hookSeen: false }) });
    expect(v).toMatchObject({ state: 'idle', stateEvidence: 'discovery' });
  });

  it('keeps its first generation number before and after the first hook, so a pending request does not look stale', () => {
    expect(build({ managed: managed() }).generation).toBe(1);
    expect(build({ managed: managed(), reducer: reducer({ n: 1 }) }).generation).toBe(1);
    expect(build({ managed: managed(), reducer: reducer({ n: 2 }) }).generation).toBe(2);
    expect(build({ managed: managed(), reducer: reducer({ n: 0, phase: 'none' }) }).generation).toBe(1);
  });

  it('shows the terminal size and whether it exited', () => {
    expect(build({ managed: managed({ cols: 100, rows: 40 }) }).terminal).toEqual({ cols: 100, rows: 40, exited: false });
    expect(build({ managed: managed({ status: 'exited', exitedAt: 'x', exitCode: 0 }) }).terminal).toEqual({ cols: 120, rows: 32, exited: true });
    expect(build({ reducer: reducer() }).terminal).toBeNull();
  });

  it('is "ended" once its terminal exited, even if no SessionEnd hook arrived: the exit was seen by Mini-Summa itself', () => {
    const v = build({ managed: managed({ status: 'exited', exitedAt: 'E', exitCode: 0, prompted: true }), reducer: reducer({ state: 'working' }) });
    expect(v).toMatchObject({ state: 'ended', stateLabel: 'Session ended', stateEvidence: 'managed:pty', availability: 'resumable' });
    expect(v.termination).toEqual({ kind: 'observed', reason: 'The terminal process exited with code 0.', at: 'E' });
  });

  it('keeps the hook evidence when the SessionEnd hook did arrive', () => {
    const v = build({ managed: managed({ status: 'exited', exitedAt: 'E', exitCode: 0 }), reducer: reducer({ state: 'ended', evidence: 'hook:SessionEnd', phase: 'ended_observed', term: 'hook_session_end' }) });
    expect(v).toMatchObject({ state: 'ended', stateEvidence: 'hook:SessionEnd' });
  });

  it.each([
    [{ exitReason: 'Stopped from Mini-Summa.', exitCode: 0 }, 'Stopped from Mini-Summa.'],
    [{ exitCode: 3 }, 'The terminal process exited with code 3.'],
    [{ exitSignal: 9 }, 'The terminal process was stopped by signal 9.'],
    [{}, 'The terminal was closed.'],
  ])('describes how the terminal ended: %j', (patch, reason) => {
    const v = build({ managed: managed({ status: 'exited', exitedAt: 'E', ...patch }) });
    expect(v.termination).toEqual({ kind: 'observed', reason, at: 'E' });
  });

  it('after a restart it keeps the last known state, says so, and stops asking for answers nobody can give', () => {
    const v = build({
      managed: managed({ status: 'disconnected', prompted: true, pid: null }), reducer: reducer({ state: 'needs_permission', evidence: 'hook:PermissionRequest' }),
      facts: facts({ stateSince: { state: 'needs_permission', at: 'S' } }),
    });
    expect(v).toMatchObject({ state: 'needs_permission', stateLabel: 'Needs permission (last known)', availability: 'disconnected', resumable: true, attention: null, pid: null });
  });

  it('a disconnected terminal that was already seen ending or vanishing needs no "last known"', () => {
    expect(build({ managed: managed({ status: 'disconnected' }), reducer: reducer({ state: 'presence_lost', phase: 'lost_suspected', term: 'absent_from_snapshot' }) }).stateLabel).toBe('Presence lost (suspected)');
    expect(build({ managed: managed({ status: 'disconnected' }) }).stateLabel).toBe('Status unknown');
  });

  it('reports remote control as started', () => {
    expect(build({ managed: managed({ remoteControl: true }) }).remoteControl).toMatchObject({ state: 'enabled' });
    expect(build({ managed: managed({ remoteControl: false }) }).remoteControl).toMatchObject({ state: 'not_enabled', hint: expect.stringContaining('/remote-control') });
    expect(build({ managed: managed({ remoteControl: true, status: 'exited', exitedAt: 'x', exitCode: 0 }) }).remoteControl.state).toBe('not_enabled');
  });
});

describe('an observed session', () => {
  it('has live state from the reducer, and a hint to type /remote-control inside it', () => {
    const v = build({ reducer: reducer({ state: 'working', evidence: 'hook:PreToolUse', proc: { pid: 77, startedAt: Date.UTC(2026, 0, 1, 9, 0, 0) } }), facts: facts({ lastHookAt: 'L' }) });
    expect(v).toMatchObject({ availability: 'live', state: 'working', stateLabel: 'Working', stateEvidence: 'hook:PreToolUse', pid: 77, startedAt: '2026-01-01T09:00:00.000Z', terminal: null });
    expect(v.remoteControl).toEqual({ state: 'unknown', hint: 'Type /remote-control inside that Claude session to control it from the Claude app' });
    expect(EXTERNAL_REMOTE_CONTROL_HINT).toBe(v.remoteControl.hint);
  });

  it('reports no remote control and no pid once it is not live', () => {
    const v = build({ reducer: reducer({ phase: 'ended_observed', state: 'ended', term: 'process_exit', proc: { pid: 77, startedAt: 1 } }) });
    expect(v.pid).toBeNull();
    expect(v.remoteControl.state).toBe('not_enabled');
  });

  it('labels every state in words (the library labels, plus Starting / Status unknown for "unknown")', () => {
    const states: SessionState[] = ['idle', 'working', 'needs_permission', 'needs_input', 'waiting_for_you', 'turn_ended', 'background_wait', 'report_ready', 'error', 'ended', 'presence_lost'];
    expect(states.map((s) => labelOf(s))).toEqual([
      'Idle', 'Working', 'Needs permission', 'Needs input', 'Waiting for you (inferred)', 'Turn ended', 'Turn ended, background work pending', 'Report ready', 'Error', 'Session ended', 'Presence lost (suspected)',
    ]);
    expect(labelOf('unknown')).toBe('Status unknown');
    expect(build({ reducer: reducer({ state: 'unknown', evidence: 'none', hookSeen: false }) }).stateLabel).toBe('Status unknown');
  });
});

describe('attention', () => {
  const live = (state: SessionState, f: Partial<SessionFacts> = {}) => build({ reducer: reducer({ state }), facts: facts(f) }).attention;
  it('maps the states that need a person', () => {
    expect(live('needs_permission')?.kind).toBe('permission');
    expect(live('needs_input')?.kind).toBe('input');
    expect(live('error')?.kind).toBe('error');
    expect(live('report_ready')?.kind).toBe('report');
  });
  it('is absent for the states that do not', () => {
    for (const s of ['idle', 'working', 'waiting_for_you', 'turn_ended', 'background_wait', 'unknown'] as SessionState[]) expect(live(s), s).toBeNull();
  });
  it('flags presence_lost and an abnormal end, but not a normal end', () => {
    expect(build({ reducer: reducer({ state: 'presence_lost', phase: 'lost_suspected', term: 'absent_from_snapshot' }) }).attention?.kind).toBe('presence_lost');
    const ended = reducer({ state: 'ended', phase: 'ended_observed', term: 'hook_session_end' });
    expect(build({ reducer: ended, facts: facts({ abnormalEnd: true }) }).attention?.kind).toBe('abnormal_end');
    expect(build({ reducer: ended, facts: facts({ abnormalEnd: false }) }).attention).toBeNull();
  });
  it('says since when: the time the state began, else the last hook', () => {
    expect(live('needs_permission', { stateSince: { state: 'needs_permission', at: 'S' }, lastHookAt: 'L' })?.since).toBe('S');
    expect(live('needs_permission', { stateSince: { state: 'working', at: 'S' }, lastHookAt: 'L' })?.since).toBe('L');
    expect(live('needs_permission')?.since).toBeNull();
  });
  it('drops permission and input when nobody can answer them any more, but keeps a report', () => {
    const gone = (state: SessionState) => build({ managed: managed({ status: 'disconnected', prompted: true }), reducer: reducer({ state }) }).attention;
    expect(gone('needs_permission')).toBeNull();
    expect(gone('needs_input')).toBeNull();
    expect(gone('report_ready')?.kind).toBe('report');
  });
});

describe('the other fields', () => {
  it('passes the attribution through, and marks the project default', () => {
    const v = build({ reducer: reducer(), attribution: attribution({ projectId: 'p9', projectName: 'Nine', resolution: 'manual' }), projectDefaultKey: KEY });
    expect(v).toMatchObject({ projectId: 'p9', projectName: 'Nine', projectResolution: 'manual', isProjectDefault: true });
    expect(build({ reducer: reducer(), projectDefaultKey: `posix|other` as never }).isProjectDefault).toBe(false);
    expect(build({ reducer: reducer(), attribution: attribution({ projectId: null, projectName: null, resolution: 'unregistered_directory' }) })).toMatchObject({ projectId: null, projectResolution: 'unregistered_directory' });
  });

  it('counts the hook events whose order could not be established', () => {
    expect(build({ reducer: reducer({ unresolved: 3 }) }).unresolvedOrdering).toBe(3);
    expect(build({ reducer: reducer() }).unresolvedOrdering).toBe(0);
  });

  it('prefers the name given at start, then the one `claude agents` reported', () => {
    expect(build({ managed: managed({ name: 'Mine' }), facts: facts({ name: 'Theirs' }) }).name).toBe('Mine');
    expect(build({ reducer: reducer(), facts: facts({ name: 'Theirs' }) }).name).toBe('Theirs');
    expect(build({ reducer: reducer() }).name).toBeNull();
  });

  it('knows when the session started: the terminal, else the process, else the first SessionStart hook', () => {
    expect(build({ managed: managed({ startedAt: 'M' }), reducer: reducer({ proc: { pid: 1, startedAt: 0 } }) }).startedAt).toBe('M');
    expect(build({ reducer: reducer({ proc: { pid: 1, startedAt: Date.UTC(2026, 0, 2) } }), facts: facts({ startedAtHook: 'H' }) }).startedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(build({ reducer: reducer(), facts: facts({ startedAtHook: 'H' }) }).startedAt).toBe('H');
    expect(build({ reducer: reducer({ proc: { pid: 1, startedAt: Number.NaN } }) }).startedAt).toBeNull();
    expect(build({ reducer: reducer({ proc: { pid: 1, startedAt: 8.64e15 + 1 } }) }).startedAt).toBeNull();
  });

  it('last activity is the latest of the last hook and the last terminal output', () => {
    expect(build({ managed: managed({ lastOutputAt: '2026-01-01T10:30:00.000Z' }), reducer: reducer(), facts: facts({ lastHookAt: '2026-01-01T10:10:00.000Z' }) }).lastActivityAt).toBe('2026-01-01T10:30:00.000Z');
    expect(build({ managed: managed({ lastOutputAt: null }), reducer: reducer(), facts: facts({ lastHookAt: '2026-01-01T10:10:00.000Z' }) }).lastActivityAt).toBe('2026-01-01T10:10:00.000Z');
    expect(build({ managed: managed() }).lastActivityAt).toBe('2026-01-01T10:00:00.000Z');
    expect(build({ reducer: reducer() }).lastActivityAt).toBeNull();
  });

  it('uses the reducer\'s working directory before the record\'s', () => {
    expect(build({ managed: managed({ cwd: '/rec' }), reducer: reducer({ cwd: '/hook' }) }).cwd).toBe('/hook');
    expect(build({ managed: managed({ cwd: '/rec' }), reducer: reducer({ cwd: null }) }).cwd).toBe('/rec');
  });

  it('is built with its fields in a fixed order, so equal views have equal JSON', () => {
    const a = build({ managed: managed(), reducer: reducer() });
    const b = build({ managed: managed(), reducer: reducer() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a)).toEqual([
      'key', 'env', 'sessionId', 'origin', 'availability', 'termination', 'resumable', 'projectId', 'projectName', 'projectResolution', 'cwd', 'name',
      'state', 'stateLabel', 'stateEvidence', 'generation', 'pid', 'startedAt', 'lastActivityAt', 'attention', 'unresolvedOrdering', 'terminal',
      'isProjectDefault', 'remoteControl',
    ]);
  });
});

describe('a session nothing else remembers (history)', () => {
  const stored = (over: Partial<SessionViewInput> = {}): SessionView => build({ reducer: reducer({ state: 'working', evidence: 'hook:PreToolUse', proc: { pid: 5, startedAt: 1 } }), facts: facts({ lastHookAt: 'L' }), ...over });

  it('has no view at all when there is neither a record, nor reducer data, nor a persisted view', () => {
    expect(buildSessionView({ key: KEY, env: 'posix', sessionId: SID, reducer: null, facts: null, managed: null, attribution: attribution(), projectDefaultKey: null, history: null })).toBeNull();
  });

  it('never shows a persisted live session as live: the connection is unknown', () => {
    const live = stored();
    expect(live.availability).toBe('live');
    const v = build({ history: live });
    expect(v).toMatchObject({ availability: 'disconnected', pid: null, state: 'working', stateLabel: 'Working (last known)' });
    expect(v.remoteControl.state).toBe('not_enabled');
  });

  it('keeps a persisted ended, resumable or disconnected session as it was', () => {
    const ended = stored({ reducer: reducer({ state: 'ended', phase: 'ended_observed', term: 'hook_session_end', prompted: true }), facts: facts({ sessionEndReason: 'other' }) });
    const v = build({ history: ended });
    expect(v).toMatchObject({ availability: 'ended', resumable: true, state: 'ended', stateLabel: 'Session ended', termination: ended.termination });
  });

  it('applies a binding that exists now, and otherwise keeps the persisted attribution', () => {
    const old = stored({ attribution: attribution({ projectId: 'old', projectName: 'Old', resolution: 'matched' }) });
    expect(build({ history: old, attribution: attribution({ projectId: null, projectName: null, resolution: 'no_cwd' }) })).toMatchObject({ projectId: 'old', projectName: 'Old', projectResolution: 'matched' });
    expect(build({ history: old, attribution: attribution({ projectId: 'p2', projectName: 'Two', resolution: 'manual' }) })).toMatchObject({ projectId: 'p2', projectName: 'Two', projectResolution: 'manual' });
  });

  it('recomputes whether it is a project\'s default', () => {
    expect(build({ history: stored(), projectDefaultKey: KEY }).isProjectDefault).toBe(true);
    expect(build({ history: stored(), projectDefaultKey: null }).isProjectDefault).toBe(false);
  });

  it('uses persisted values only where the live sources have none', () => {
    const old = stored({ managed: managed({ name: 'Remembered' }), reducer: reducer({ cwd: '/old' }) });
    const v = build({ reducer: reducer({ cwd: null }), history: old });
    expect(v.name).toBe('Remembered');
    expect(v.cwd).toBe('/old');
  });
});
