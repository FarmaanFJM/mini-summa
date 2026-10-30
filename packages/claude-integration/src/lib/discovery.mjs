import { execFile } from 'node:child_process';
import path from 'node:path';

// Documented fields of `claude agents --json` (code.claude.com/docs/en/agent-view).
export const DOCUMENTED = {
  always: ['cwd', 'kind', 'startedAt'],
  background_only: ['id', 'state'],
  while_alive: ['pid', 'status'],
  conditional: ['waitingFor', 'sessionId', 'name'],
};
const ALL_DOCUMENTED = new Set(Object.values(DOCUMENTED).flat());

export function normalizeAgents(json) {
  if (!Array.isArray(json)) throw new Error('claude agents --json did not return an array');
  return json.map((o) => ({
    kind: o.kind ?? null,
    cwd: o.cwd ?? null,
    startedAt: o.startedAt ?? null,
    id: o.id ?? null,
    state: o.state ?? null,
    pid: o.pid ?? null,
    status: o.status ?? null,
    waitingFor: o.waitingFor ?? null,
    sessionId: o.sessionId ?? null,
    name: o.name ?? null,
    _extra_keys: Object.keys(o).filter((k) => !ALL_DOCUMENTED.has(k)),
  }));
}

// Field validation against the installed CLI: nothing optional is assumed to exist.
export function validateAgents(json) {
  const report = { count: json.length, missing_always: [], undocumented_keys: new Set(), no_sessionId: 0, kinds: {}, key_presence: {} };
  json.forEach((o, i) => {
    for (const k of DOCUMENTED.always) if (!(k in o)) report.missing_always.push({ index: i, field: k });
    for (const k of Object.keys(o)) {
      report.key_presence[k] = (report.key_presence[k] ?? 0) + 1;
      if (!ALL_DOCUMENTED.has(k)) report.undocumented_keys.add(k);
    }
    if (!o.sessionId) report.no_sessionId++;
    report.kinds[o.kind] = (report.kinds[o.kind] ?? 0) + 1;
  });
  report.undocumented_keys = [...report.undocumented_keys];
  return report;
}

// Resolve the claude executable. Native Windows installs ship claude.exe; an npm install ships claude.cmd,
// which cannot be started without a shell. MINI_SUMMA_CLAUDE_BIN overrides.
export function claudeBin(env = process.env, platform = process.platform) {
  return env.MINI_SUMMA_CLAUDE_BIN || (platform === 'win32' ? 'claude.exe' : 'claude');
}

// One argument of a command line that cmd.exe will parse. Inside double quotes cmd treats nothing as special except the
// percent sign (an environment variable is expanded even there), the exclamation mark when delayed expansion happens to be
// switched on, and the double quote itself, which cannot be escaped reliably. Those, and control characters, are refused
// instead of being passed on in a way that might run something else. A trailing backslash is doubled: the program that
// finally reads the line (node, behind the npm shim) would take `\"` as an escaped quote.
function quoteForCmd(arg) {
  if (/[\u0000-\u001f"%!]/.test(arg)) {
    throw new Error(`cannot pass ${JSON.stringify(arg)} through cmd.exe: it contains a control character, a double quote, a percent sign or an exclamation mark`);
  }
  if (/^[A-Za-z0-9_.:+\\/-]+$/.test(arg)) return arg;
  return `"${arg.replace(/\\+$/, (run) => run + run)}"`;
}

// The process to start for `claude agents --json`, as data, so the Windows rules can be unit-tested on any machine.
//   file, args        the command as the caller sees it (what is reported back, and in error messages)
//   spawnFile, spawnArgs, windowsVerbatimArguments
//                     what is really started. For everything except a .cmd or .bat shim on Windows this is the same as
//                     file and args. An npm install of Claude Code is such a shim, and it cannot be started without a
//                     shell; Node's own `shell: true` pastes the arguments together without quoting, so a shim path or a
//                     --cwd with a space broke it. Instead: cmd.exe /d /s /c "<each part quoted>", passed verbatim.
//                     (Not run on Windows by the tests of this package.)
export function agentsCommand({ configDir, cwd, all, wslDistro, bin, platform = process.platform, comSpec = process.env.ComSpec } = {}) {
  const args = ['agents', '--json'];
  if (all) args.push('--all');
  if (cwd) args.push('--cwd', cwd);
  let file = bin ?? claudeBin(process.env, platform); let argv = args;
  if (wslDistro) {
    const inner = configDir ? ['env', `CLAUDE_CONFIG_DIR=${configDir}`, 'claude', ...args] : ['claude', ...args];
    file = 'wsl.exe'; argv = ['-d', wslDistro, '--exec', ...inner];
  }
  const command = { file, args: argv, spawnFile: file, spawnArgs: argv, windowsVerbatimArguments: false };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    command.spawnFile = comSpec || 'cmd.exe';
    command.spawnArgs = ['/d', '/s', '/c', `"${[file, ...argv].map(quoteForCmd).join(' ')}"`];
    command.windowsVerbatimArguments = true;
  }
  return command;
}

// taskkill.exe by its full path (a bare name is looked up in the current directory first), only from a local drive's SystemRoot.
function taskkillPath(env = process.env) {
  const root = [env.SystemRoot, env.windir].find((v) => typeof v === 'string' && /^[A-Za-z]:[\\/][^"<>|*?\u0000-\u001f]*$/.test(v.trim()));
  return path.win32.join(root ? root.trim() : 'C:\\Windows', 'System32', 'taskkill.exe');
}

// Ends a Windows process and everything it started (`taskkill /pid N /T /F`). Resolves when taskkill is done; never rejects.
// The tree is found through the parent links, which are gone once the parent has died, so this runs BEFORE the parent is killed.
function killTreeWindows(pid) {
  return new Promise((resolve) => {
    try { execFile(taskkillPath(), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve()); } catch { resolve(); }
  });
}

// execFile with a deadline, and an input that is closed at once so a program that waits for input ends instead of waiting for ever.
// On Windows the deadline is kept here, not in execFile: the npm `claude.cmd` is a batch file started as `cmd.exe /d /s /c ...`, and
// killing cmd.exe at execFile's deadline leaves the node.exe behind it running with the pipes open, so the callback would never
// come (and whatever awaits the result, the discovery pass, would wait for ever). The tree is ended first, then the process.
// Resolves with { err, stdout, stderr, timedOut } and never rejects. `platform` and `killTree` are test seams.
export function execWithDeadline(file, args, options, { timeoutMs, platform = process.platform, killTree = killTreeWindows } = {}) {
  return new Promise((resolve) => {
    let timer;
    let timedOut = false;
    let child;
    try {
      child = execFile(file, args, { ...options, ...(platform === 'win32' ? {} : { timeout: timeoutMs }) }, (err, stdout, stderr) => {
        clearTimeout(timer);
        resolve({ err, stdout, stderr, timedOut });
      });
    } catch (err) { resolve({ err, stdout: '', stderr: '', timedOut: false }); return; }
    child.stdin?.on('error', () => {}); // the program may be gone before the input closes
    child.stdin?.end();
    if (platform === 'win32') {
      timer = setTimeout(() => {
        timedOut = true;
        const finish = () => { try { child.kill(); } catch { /* already gone */ } };
        if (Number.isInteger(child.pid) && child.pid > 0) Promise.resolve(killTree(child.pid)).then(finish, finish); else finish();
      }, timeoutMs);
    }
  });
}

// Runs `claude agents --json`. With wslDistro it runs inside that distribution through wsl.exe, so the
// answer describes WSL sessions (their own ~/.claude), never Windows ones.
export function runAgentsJson({ configDir, cwd, all, wslDistro, timeoutMs = 20000, bin } = {}) {
  const env = { ...process.env };
  if (configDir && !wslDistro) env.CLAUDE_CONFIG_DIR = configDir;
  let command;
  try { command = agentsCommand({ configDir, cwd, all, wslDistro, bin }); } catch (err) { return Promise.reject(err); }
  const { file, args: argv, spawnFile, spawnArgs, windowsVerbatimArguments } = command;
  return execWithDeadline(spawnFile, spawnArgs, { env, maxBuffer: 8 * 1024 * 1024, windowsVerbatimArguments, windowsHide: true }, { timeoutMs })
    .then(({ err, stdout, stderr, timedOut }) => {
      if (timedOut) throw Object.assign(new Error(`${file} ${argv.join(' ')} failed: timed out after ${Math.round(timeoutMs / 1000)} seconds`), { stderr });
      if (err) throw Object.assign(new Error(`${file} ${argv.join(' ')} failed: ${err.message}`), { stderr });
      try { return { raw: JSON.parse(stdout), args: argv, file }; }
      catch { throw new Error(`unparsable output: ${stdout.slice(0, 200)}`); }
    });
}

// Same-host liveness hint. null = cannot be checked (a pid from another OS or from inside WSL).
export function pidAlive(pid, { remote = false } = {}) {
  if (remote || !Number.isInteger(pid)) return null;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Q18: do native Windows and one WSL distribution discover their sessions SEPARATELY?
// Decided from two `agents --json` arrays. PASS needs real evidence in BOTH environments, so an empty listing, a
// listing without usable ids, or a failed query can never count as "separation".
//   FAIL        a query failed or returned a non-array; the same session id appears in both; an expected id is
//               missing from its own environment or present in the other one
//   NOT TESTED  no valid, independently identified session in one or both environments (nothing to separate)
//   PASS        at least one valid session in each, no shared id, and any expected ids found where they belong
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function evaluateSeparateDiscovery({ win, wsl, expect = {} }) {
  const notes = [];
  for (const [name, v] of [['Windows', win], ['WSL', wsl]]) {
    if (v instanceof Error) return { status: 'FAIL', notes: [`${name} discovery failed: ${String(v.message).slice(0, 200)}`] };
    if (!Array.isArray(v)) return { status: 'FAIL', notes: [`${name} discovery did not return a list`] };
  }
  const ids = (list) => list.filter((s) => s && typeof s.sessionId === 'string' && UUID.test(s.sessionId)).map((s) => s.sessionId.toLowerCase());
  const w = ids(win); const l = ids(wsl);
  const unidentified = (win.length - w.length) + (wsl.length - l.length);
  notes.push(`Windows lists ${win.length} (${w.length} with a valid session id), WSL lists ${wsl.length} (${l.length} with a valid session id)`);
  if (unidentified) notes.push(`${unidentified} listed session(s) have no valid session id and are not counted as evidence`);
  const shared = w.filter((x) => l.includes(x));
  if (shared.length) return { status: 'FAIL', notes: [...notes, `identity collision: ${shared.length} session id(s) appear in both environments`] };
  const ew = expect.win?.toLowerCase(); const el = expect.wsl?.toLowerCase();
  if (ew && l.includes(ew)) return { status: 'FAIL', notes: [...notes, 'the Windows session id was listed inside WSL'] };
  if (el && w.includes(el)) return { status: 'FAIL', notes: [...notes, 'the WSL session id was listed by Windows'] };
  if (ew && !w.includes(ew)) return { status: 'NOT TESTED', notes: [...notes, 'the expected Windows session was not listed: not started yet, or not discovered'] };
  if (el && !l.includes(el)) return { status: 'NOT TESTED', notes: [...notes, 'the expected WSL session was not listed: not started yet, or not discovered'] };
  if (w.length === 0 || l.length === 0) {
    return { status: 'NOT TESTED', notes: [...notes, `no valid live session was established in ${w.length === 0 && l.length === 0 ? 'either environment' : w.length === 0 ? 'Windows' : 'WSL'}: start an idle session there first (see docs/QUALIFICATION.md), then rerun`] };
  }
  notes.push('WSL pid liveness is unknown from Windows by design');
  return { status: 'PASS', notes };
}
