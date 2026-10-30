import path from 'node:path';

// Pure builders for the isolated test configuration. Nothing here touches the disk.
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'StopFailure', 'SessionEnd'];

const FORBIDDEN_IN_PS = /["`$\r\n]/;

// One hook command line. On Windows the documented `shell: "powershell"` field is set, so Claude Code runs the
// command in PowerShell regardless of whether Git Bash is installed. The absolute node path avoids depending on PATH.
export function hookCommand({ env, node, capture, spool, registry, handler, event }) {
  const parts = { node, capture, spool, registry, handler, event };
  for (const [k, v] of Object.entries(parts)) if (typeof v !== 'string' || v === '') throw new Error(`hookCommand: ${k} required`);
  if (env === 'win') {
    for (const [k, v] of Object.entries({ node, capture, spool, registry })) {
      if (FORBIDDEN_IN_PS.test(v)) throw new Error(`path for ${k} contains a character that is unsafe inside a PowerShell string: ${v}`);
    }
    const q = (s) => `"${s}"`;
    return { type: 'command', shell: 'powershell', timeout: 5,
      command: `& ${q(node)} ${q(capture)} --spool ${q(spool)} --registry ${q(registry)} --env win --handler ${handler} ${event}` };
  }
  for (const [k, v] of Object.entries({ node, capture, spool, registry })) {
    if (/["\r\n]/.test(v) || v.includes('$') || v.includes('`')) throw new Error(`path for ${k} contains a character that is unsafe inside a shell string: ${v}`);
  }
  const q = (s) => `"${s}"`;
  return { type: 'command', timeout: 5,
    command: `${q(node)} ${q(capture)} --spool ${q(spool)} --registry ${q(registry)} --env ${env} --handler ${handler} ${event}` };
}

// handlers: ['h1'] for normal use, ['h1','h2'] for qualification (every event is then delivered twice on purpose).
export function buildSettings({ env, node, capture, spool, registry, handlers = ['h1'] }) {
  const hooks = {};
  for (const event of EVENTS) {
    hooks[event] = [{ hooks: handlers.map((handler) => hookCommand({ env, node, capture, spool, registry, handler, event })) }];
  }
  return { hooks };
}

// Where things live. `shared` must be visible from Windows (the ingestor runs there); WSL reaches it through /mnt/<drive>/.
export function layout({ env, base, shared }) {
  const join = env === 'win' ? path.win32.join : path.posix.join;
  const tag = env === 'win' ? 'win' : env.replace(/[^A-Za-z0-9_-]+/g, '-');
  return {
    config: join(base, `config-${tag}`),
    work: join(base, 'work'),
    spool: join(shared, `spool-${tag}`),
    registry: join(shared, 'registry.json'),
    store: join(shared, 'store'),
    reports: join(shared, 'qualification'),
  };
}

// True if `dir` is one of the normal Claude configuration directories (or inside one). The setup script refuses these.
export function isNormalConfigDir(dir, homes, normalEnv = process.env.CLAUDE_CONFIG_DIR) {
  const lib = /^[A-Za-z]:[\\/]|^\\\\/.test(dir) ? path.win32 : path.posix;
  const key = (p) => (lib === path.win32 ? lib.resolve(p).toLowerCase() : lib.resolve(p));
  const d = key(dir);
  const normals = [...homes.filter(Boolean).map((h) => lib.join(h, '.claude')), normalEnv].filter(Boolean).map(key);
  return normals.some((n) => d === n || d.startsWith(n + lib.sep));
}
