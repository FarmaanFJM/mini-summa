import { execFile } from 'node:child_process';

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

// Runs `claude agents --json`. With wslDistro it runs inside that distribution through wsl.exe, so the
// answer describes WSL sessions (their own ~/.claude), never Windows ones.
export function runAgentsJson({ configDir, cwd, all, wslDistro, timeoutMs = 20000, bin } = {}) {
  const args = ['agents', '--json'];
  if (all) args.push('--all');
  if (cwd) args.push('--cwd', cwd);
  const env = { ...process.env };
  if (configDir && !wslDistro) env.CLAUDE_CONFIG_DIR = configDir;
  let file = bin ?? claudeBin(); let argv = args;
  if (wslDistro) {
    const inner = configDir ? ['env', `CLAUDE_CONFIG_DIR=${configDir}`, 'claude', ...args] : ['claude', ...args];
    file = 'wsl.exe'; argv = ['-d', wslDistro, '--exec', ...inner];
  }
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
  return new Promise((resolve, reject) => {
    execFile(file, argv, { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(`${file} ${argv.join(' ')} failed: ${err.message}`), { stderr }));
      try { resolve({ raw: JSON.parse(stdout), args: argv, file }); }
      catch { reject(new Error(`unparsable output: ${stdout.slice(0, 200)}`)); }
    });
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
