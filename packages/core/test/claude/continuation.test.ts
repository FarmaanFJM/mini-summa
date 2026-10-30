// The rules that decide when a new Claude session id provably belongs to a terminal Mini-Summa owns (continuation.ts), as a table of
// facts and verdicts: no database, no processes. Ids are synthetic.
import { describe, expect, it } from 'vitest';
import type { EnvId, SessionKey } from '@minisumma/shared';
import { MANAGED_HANDLER, decideContinuations, parseReplacedReason, replacedReason, successorOf } from '../../src/claude/continuation.ts';
import type { CandidateFact, EnvEvidence, HookMark, ListedProcess, SessionTrace, TerminalFact } from '../../src/claude/continuation.ts';
import { defaultParentPid, isSameOrBelow } from '../../src/claude/processTree.ts';

const ID = (n: number): string => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const K1 = ID(1);
const K2 = ID(2);
const S1 = ID(3);
const S2 = ID(4);
const CWD = '/w/proj';
const key = (env: EnvId, id: string): SessionKey => `${env}|${id}`;

let seq = 0;
const mark = (value: string | null, over: Partial<HookMark> = {}): HookMark => ({ seq: ++seq, value, handler: MANAGED_HANDLER, cwd: CWD, ...over });
const trace = (o: { first?: SessionTrace['first']; starts?: HookMark[]; ends?: HookMark[] }): SessionTrace => ({ first: o.first ?? null, starts: o.starts ?? [], ends: o.ends ?? [] });

/** A terminal whose session started at the beginning and then ended with /clear. */
function endedTerminal(over: Partial<TerminalFact> = {}, endReason: string | null = 'clear', endHandler: string | null = MANAGED_HANDLER): TerminalFact {
  const t = over.sessionId ?? K1;
  const start = mark('startup');
  return {
    key: key(over.env ?? 'posix', t), env: 'posix', sessionId: t, cwds: [CWD], pid: 4321, phase: 'ended_observed', listingBlind: false,
    trace: trace({ first: { event: 'SessionStart', value: 'startup', seq: start.seq }, starts: [start], ends: [mark(endReason, { handler: endHandler })] }),
    ...over,
  };
}

/** A session that announced itself with SessionStart `source` as the very first thing the log knows about it. */
function announced(sessionId: string, source: string | null = 'clear', over: Partial<CandidateFact> = {}, startOver: Partial<HookMark> = {}): CandidateFact {
  const start = mark(source, startOver);
  return {
    key: key('posix', sessionId), env: 'posix', sessionId, cwd: CWD, phase: 'live', managedRunning: false,
    trace: trace({ first: { event: 'SessionStart', value: source, seq: start.seq }, starts: [start] }), ...over,
  };
}

const env = (listing: ListedProcess[] | null, comparable = true, id: EnvId = 'posix'): Map<EnvId, EnvEvidence> => new Map([[id, { env: id, comparable, listing }]]);
const row = (sessionId: string | null, pid: number | null, over: Partial<ListedProcess> = {}): ListedProcess => ({ sessionId, pid, pidAlive: true, kind: 'interactive', cwd: CWD, ...over });
const none = (): null => null;

const decide = (terminals: TerminalFact[], candidates: CandidateFact[], envs: Map<EnvId, EnvEvidence>, ancestry: (pid: number, of: number) => boolean | null = none) =>
  decideContinuations({ terminals, candidates, envs, ancestry });

describe('the process id decides wherever it can', () => {
  it('adopts the session Claude lists for the terminal\'s own process, with or without any hook', () => {
    const d = decide([endedTerminal()], [announced(S1)], env([row(S1, 4321)]));
    expect(d.adopt).toEqual([expect.objectContaining({ terminal: key('posix', K1), to: key('posix', S1), toSessionId: S1, via: 'pid', cause: 'clear' })]);
    // no hook at all: a listing alone is enough, because only Claude can say what a process runs
    const bare = decide([endedTerminal()], [{ ...announced(S1), trace: null }], env([row(S1, 4321)]));
    expect(bare.adopt).toHaveLength(1);
    expect(bare.adopt[0].cause).toBe('clear');  // taken from how the terminal's session ended
    const alive = decide([{ ...endedTerminal(), phase: 'live', trace: null }], [], env([row(S1, 4321)]));
    expect(alive.adopt).toHaveLength(1);        // even a terminal whose end was never heard of follows its process
    expect(alive.adopt[0].cause).toBe('other');
  });

  it('does nothing while the listing still shows the old id for the process, but asks for a fresh one when the hooks say it ended', () => {
    const quiet = decide([{ ...endedTerminal(), phase: 'live', trace: null }], [], env([row(K1, 4321)]));
    expect(quiet).toEqual({ adopt: [], pending: [], unresolved: [] });
    const stale = decide([endedTerminal()], [announced(S1)], env([row(K1, 4321)]));
    expect(stale.adopt).toEqual([]);
    expect(stale.pending).toEqual([key('posix', K1)]);
  });

  it('waits (pending) when the listing is healthy but does not show the process yet; gives up on it once the wait is exhausted', () => {
    const wait = decide([endedTerminal()], [announced(S1)], env([]));
    expect(wait.pending).toEqual([key('posix', K1)]);
    expect(wait.adopt).toEqual([]);
    // never in a listing although fresh ones were asked for: the hooks may speak (strictly), and the pid no longer vetoes
    const blind = decide([endedTerminal({ listingBlind: true })], [announced(S1)], env([]));
    expect(blind.adopt).toEqual([expect.objectContaining({ via: 'hooks', to: key('posix', S1) })]);
  });

  it('never adopts a session a healthy listing shows under another process, whatever the hooks claim (a forged record cannot win)', () => {
    const forged = announced(S1, 'clear');
    const d = decide([endedTerminal()], [forged], env([row(S1, 9999), row(K1, 4321, { pidAlive: false })]), () => false);
    expect(d.adopt).toEqual([]);
    // the process of the terminal is listed with a session id of its own: that one is adopted, not the stranger
    const both = decide([endedTerminal()], [forged, announced(S2)], env([row(S1, 9999), row(S2, 4321)]), (pid) => pid === 9999 ? false : null);
    expect(both.adopt.map((a) => a.toSessionId)).toEqual([S2]);
  });

  it('follows a launcher: the listed process was started by the terminal\'s process', () => {
    const below = decide([endedTerminal()], [announced(S1)], env([row(S1, 5555)]), (pid, of) => pid === 5555 && of === 4321);
    expect(below.adopt).toEqual([expect.objectContaining({ via: 'pid', to: key('posix', S1) })]);
    const unrelated = decide([endedTerminal()], [announced(S1)], env([row(S1, 5555)]), () => false);
    expect(unrelated.adopt).toEqual([]);
  });

  it('a session of a process the terminal started deeper down (a tool\'s `claude -p`) is never taken for the terminal\'s own', () => {
    // the terminal's own process is listed: only exact matches count, whatever else descends from it
    const exact = decide([endedTerminal()], [announced(S1), announced(S2)], env([row(S1, 4321), row(S2, 5555)]), () => true);
    expect(exact.adopt.map((a) => a.toSessionId)).toEqual([S1]);
    // the terminal's own process is not listed (yet) and only a deeper process is: that cannot be told, so nothing is adopted by pid
    const deeper = decide([endedTerminal()], [announced(S2)], env([row(S2, 5555)]), () => null);
    expect(deeper.adopt.every((a) => a.via === 'hooks')).toBe(true);
  });

  it('says it is ambiguous (and adopts nothing) when Claude lists several sessions for one process', () => {
    const d = decide([endedTerminal()], [announced(S1), announced(S2)], env([row(S1, 4321), row(S2, 4321)]));
    expect(d.adopt).toEqual([]);
    expect(d.unresolved).toEqual([expect.objectContaining({ terminal: key('posix', K1) })]);
  });

  it('does not take a session another live terminal runs', () => {
    const other = endedTerminal({ sessionId: K2, pid: 7777 });
    const d = decide([endedTerminal()], [announced(S1, 'clear', { managedRunning: true })], env([row(S1, 4321)]));
    expect(d.adopt).toEqual([]);
    expect(d.unresolved).toHaveLength(1);
    void other;
  });

  it('two terminals, two sessions: each follows its own process (no folder guessing is needed)', () => {
    const t1 = endedTerminal({ pid: 4321 });
    const t2 = endedTerminal({ sessionId: K2, pid: 4400 });
    const d = decide([t1, t2], [announced(S1), announced(S2)], env([row(S1, 4400), row(S2, 4321)]));
    expect(d.adopt.map((a) => [a.terminal, a.to])).toEqual([[key('posix', K1), key('posix', S2)], [key('posix', K2), key('posix', S1)]]);
  });
});

describe('the hooks decide only where the process id cannot be compared, and only strictly', () => {
  const cannot: [string, Map<EnvId, EnvEvidence>, Partial<TerminalFact>][] = [
    ['the environment is not the one the core runs in', env(null, false), {}],
    ['the terminal\'s pid is not known yet', env([]), { pid: null }],
    ['there is no usable listing (discovery failed or never ran)', env(null, true), {}],
    ['the listing names no session for the process', env([row(null, 4321)]), {}],
    ['the listed pids cannot be traced to the terminal', env([row(S1, 5555)]), {}],
  ];
  for (const [why, envs, over] of cannot) {
    it(`adopts the one session that announced itself after the old one ended with /clear — when ${why}`, () => {
      const d = decide([endedTerminal(over)], [announced(S1)], envs);
      expect(d.adopt).toEqual([expect.objectContaining({ via: 'hooks', to: key('posix', S1), cause: 'clear' })]);
    });
  }

  it('treats /resume like /clear, for an older session that already has a history', () => {
    const terminal = endedTerminal({}, 'resume');
    const start = mark('startup');
    const resumed: CandidateFact = {
      ...announced(S1, 'resume'), trace: trace({ first: { event: 'SessionStart', value: 'startup', seq: start.seq }, starts: [start, mark('resume')] }),
    };
    const d = decide([terminal], [resumed], env(null, false));
    expect(d.adopt).toEqual([expect.objectContaining({ via: 'hooks', to: key('posix', S1), cause: 'resume' })]);
  });

  it('waits for the announcement when the old session ended and nothing has announced itself yet', () => {
    const d = decide([endedTerminal()], [], env(null, false));
    expect(d).toEqual({ adopt: [], pending: [key('posix', K1)], unresolved: [] });
  });

  describe('a forged or accidental record does not adopt', () => {
    const cases: [string, TerminalFact, CandidateFact][] = [
      ['the old session never ended (no SessionEnd with clear/resume)', { ...endedTerminal(), phase: 'live', trace: trace({ starts: [mark('startup')] }) }, announced(S1)],
      ['the old session ended for another reason (prompt_input_exit)', endedTerminal({}, 'prompt_input_exit'), announced(S1)],
      ['the end did not come through the managed hook registration', endedTerminal({}, 'clear', 'h1'), announced(S1)],
      ['the announcement did not come through the managed hook registration', endedTerminal(), announced(S1, 'clear', {}, { handler: 'h1' })],
      ['the announcement is another kind of start (startup)', endedTerminal(), announced(S1, 'startup')],
      ['the announcement is in another folder', endedTerminal(), announced(S1, 'clear', { cwd: '/w/other' }, { cwd: '/w/other' })],
      ['the "clear" claims an id that already has a history', endedTerminal(), {
        ...announced(S1, 'clear'),
        trace: trace({ first: { event: 'UserPromptSubmit', value: null, seq: 1 }, starts: [mark('clear')] }),
      }],
      ['the new session is not live in the reducer', endedTerminal(), announced(S1, 'clear', { phase: 'ended_observed' })],
      ['the announcement is older than the terminal\'s own start', endedTerminal(), {
        ...announced(S1, 'clear'), trace: trace({ first: { event: 'SessionStart', value: 'clear', seq: 0 }, starts: [{ seq: 0, value: 'clear', handler: MANAGED_HANDLER, cwd: CWD }] }),
      }],
    ];
    for (const [why, terminal, candidate] of cases) {
      it(`does not adopt when ${why}`, () => {
        const d = decide([terminal], [candidate], env(null, false));
        expect(d.adopt).toEqual([]);
      });
    }

    it('does not adopt in another environment: win and WSL are never merged', () => {
      const wsl = { ...announced(S1), key: key('wsl:Ubuntu', S1), env: 'wsl:Ubuntu' as EnvId };
      const d = decide([endedTerminal()], [wsl], env(null, false));
      expect(d.adopt).toEqual([]);
      const winTerminal = endedTerminal({ env: 'win', key: key('win', K1), cwds: ['C:\\w\\proj'] });
      const d2 = decide([winTerminal], [announced(S1, 'clear', { cwd: 'C:\\w\\proj' }, { cwd: 'C:\\w\\proj' })], new Map<EnvId, EnvEvidence>([['win', { env: 'win', comparable: false, listing: null }], ['posix', { env: 'posix', comparable: false, listing: null }]]));
      expect(d2.adopt).toEqual([]);   // the candidate is a posix key: not the terminal's environment
    });

    it('does not adopt a session a live terminal already runs', () => {
      const d = decide([endedTerminal()], [announced(S1, 'clear', { managedRunning: true })], env(null, false));
      expect(d.adopt).toEqual([]);
    });
  });

  describe('ambiguity is never guessed', () => {
    it('two terminals ended in one folder and two sessions announced themselves: nothing is adopted and both say so', () => {
      const d = decide([endedTerminal(), endedTerminal({ sessionId: K2, pid: 4400 })], [announced(S1), announced(S2)], env(null, false));
      expect(d.adopt).toEqual([]);
      expect(d.unresolved.map((u) => u.terminal).sort()).toEqual([key('posix', K1), key('posix', K2)].sort());
      expect(d.unresolved[0].text).toContain('cannot tell which');
    });

    it('two terminals ended in one folder and only one session announced itself: still nothing (either could be it)', () => {
      const d = decide([endedTerminal(), endedTerminal({ sessionId: K2, pid: 4400 })], [announced(S1)], env(null, false));
      expect(d.adopt).toEqual([]);
      expect(d.unresolved).toHaveLength(2);
    });

    it('one terminal ended and two sessions announced themselves: nothing', () => {
      const d = decide([endedTerminal()], [announced(S1), announced(S2)], env(null, false));
      expect(d.adopt).toEqual([]);
      expect(d.unresolved).toEqual([expect.objectContaining({ terminal: key('posix', K1), candidates: [key('posix', S1), key('posix', S2)] })]);
    });

    it('another terminal of the same folder that did not end does not make the pairing ambiguous', () => {
      const bystander: TerminalFact = { ...endedTerminal({ sessionId: K2, pid: 4400 }), phase: 'live', trace: trace({ starts: [mark('startup')] }) };
      const d = decide([endedTerminal(), bystander], [announced(S1)], env(null, false));
      expect(d.adopt).toEqual([expect.objectContaining({ terminal: key('posix', K1), to: key('posix', S1) })]);
    });

    it('terminals in different folders are paired independently', () => {
      const other = endedTerminal({ sessionId: K2, pid: 4400, cwds: ['/w/other'] });
      const theirs = announced(S2, 'clear', { cwd: '/w/other' }, { cwd: '/w/other' });
      const d = decide([endedTerminal(), other], [announced(S1), theirs], env(null, false));
      expect(d.adopt.map((a) => [a.terminal, a.to])).toEqual([[key('posix', K1), key('posix', S1)], [key('posix', K2), key('posix', S2)]]);
    });

    it('a session proven by pid for one terminal is not available to the hook pairing of another', () => {
      const t1 = endedTerminal({ pid: 4321 });
      const t2 = endedTerminal({ sessionId: K2, pid: null });          // cannot be matched by pid
      const d = decide([t1, t2], [announced(S1)], env([row(S1, 4321)]));
      expect(d.adopt.map((a) => [a.terminal, a.to, a.via])).toEqual([[key('posix', K1), key('posix', S1), 'pid']]);
      expect(d.pending).toEqual([key('posix', K2)]);                      // t2 waits: its successor has not announced itself
    });
  });

  it('a terminal that came back to an older id by /resume does not reuse the end of its earlier life', () => {
    const back: TerminalFact = {
      ...endedTerminal(), phase: 'live',
      trace: trace({ starts: [{ seq: 10, value: 'startup', handler: MANAGED_HANDLER, cwd: CWD }, { seq: 70, value: 'resume', handler: MANAGED_HANDLER, cwd: CWD }], ends: [{ seq: 40, value: 'clear', handler: MANAGED_HANDLER, cwd: CWD }] }),
    };
    const d = decide([back], [announced(S1)], env(null, false));
    expect(d).toEqual({ adopt: [], pending: [], unresolved: [] });
  });
});

describe('the words stored on the record that is left behind', () => {
  it('round-trip, and only well-formed values are understood', () => {
    expect(parseReplacedReason(replacedReason('clear', S1))).toEqual({ cause: 'clear', sessionId: S1 });
    expect(parseReplacedReason(replacedReason('resume', S1.toUpperCase()))).toEqual({ cause: 'resume', sessionId: S1 });
    expect(parseReplacedReason('replaced:clear:not-a-uuid')).toBeNull();
    expect(parseReplacedReason('killed_by_user')).toBeNull();
    expect(parseReplacedReason(null)).toBeNull();
    expect(successorOf('posix', replacedReason('clear', S1))).toBe(key('posix', S1));
    expect(successorOf('win', 'exited')).toBeNull();
  });
});

describe('isSameOrBelow (parent links)', () => {
  it.runIf(process.platform === 'linux')('reads the real parent link from /proc on Linux (this process\' parent is process.ppid)', () => {
    const parentOf = defaultParentPid('linux');
    expect(parentOf(process.pid)).toBe(process.ppid);
    expect(isSameOrBelow(process.pid, process.ppid, parentOf)).toBe(true);
    expect(isSameOrBelow(process.ppid, process.pid, parentOf)).toBe(false);
    expect(parentOf(2 ** 22 + 12345)).toBeUndefined();             // a process that does not exist cannot be traced
    expect(defaultParentPid('win32')(process.pid)).toBeUndefined();   // other platforms never claim anything
  });

  const tree = new Map<number, number>([[4321, 100], [5555, 4321], [6666, 5555], [7000, 1]]);
  const parentOf = (pid: number) => tree.get(pid);
  it('answers true for the process itself and for what it started, false for the rest, null when a link cannot be read', () => {
    expect(isSameOrBelow(4321, 4321, parentOf)).toBe(true);
    expect(isSameOrBelow(6666, 4321, parentOf)).toBe(true);
    expect(isSameOrBelow(7000, 4321, parentOf)).toBe(false);
    expect(isSameOrBelow(8888, 4321, parentOf)).toBeNull();
    // with a limit on the matching depth, a direct child counts, a deeper descendant cannot be told, somebody else's process is a definite no
    expect(isSameOrBelow(5555, 4321, parentOf, 1)).toBe(true);
    expect(isSameOrBelow(6666, 4321, parentOf, 1)).toBeNull();
    expect(isSameOrBelow(7000, 4321, parentOf, 1)).toBe(false);
    expect(isSameOrBelow(4321, 4321, parentOf, 0)).toBe(true);
  });
});
