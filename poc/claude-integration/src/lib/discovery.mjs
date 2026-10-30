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
