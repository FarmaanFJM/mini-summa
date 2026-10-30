import path from 'node:path';

// Pure builders for the isolated test configuration. Nothing here touches the disk.
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'StopFailure', 'SessionEnd'];

const FORBIDDEN_IN_PS = /["`$\r\n]/;

// handler, event and env are not paths but they are put on the command line too, so they get the same care
// (docs/CHANGES-FROM-POC.md, change 3). A token is refused if it holds a character that could end a quoted string or be
// expanded inside one: a quote of either kind (also the typographic ones PowerShell treats as quotes), a backtick, $, a
// control character, or a line break (also NEL and the Unicode line and paragraph separators PowerShell treats as such).
const TOKEN_UNSAFE = /["'`$\u0000-\u001f\u007f-\u009f\u2028\u2029\u2018-\u201e]/;
// A token made only of these characters means the same thing with and without quotes in the target shell, so it is written
// exactly as before: ids such as h1, event names, and environments such as wsl:Ubuntu-22.04. Anything else that is still
// allowed (a space in a distribution name, a parenthesis, a semicolon...) is put in double quotes. Not plain in PowerShell:
// a comma (it builds an array), a leading @ (splatting), and the lone token --% (stop-parsing).
const PLAIN_POSIX = /^[\p{L}\p{N}\p{M}_.:+=%@,/-]+$/u;
const PLAIN_POWERSHELL = /^[\p{L}\p{N}\p{M}_.:+=%/\\-][\p{L}\p{N}\p{M}_.:+=%@/\\-]*$/u;

function hookToken(name, value, powershell) {
  if (TOKEN_UNSAFE.test(value)) {
    throw new Error(`hookCommand: ${name} contains a character that is unsafe inside ${powershell ? 'a PowerShell' : 'a shell'} string: ${JSON.stringify(value)}`);
  }
  if (powershell) {
    if (PLAIN_POWERSHELL.test(value) && value !== '--%') return value;
    // Inside double quotes only $ and the backtick are special in PowerShell, and both are refused above. A trailing backslash would
    // escape the closing quote when PowerShell hands the argument to a program, so that one case is refused too.
    if (value.endsWith('\\')) throw new Error(`hookCommand: ${name} cannot end with a backslash because it needs quoting in PowerShell: ${JSON.stringify(value)}`);
    return `"${value}"`;
  }
  // Inside double quotes in a POSIX shell only $ and the backtick (refused above) and the backslash are special.
  return PLAIN_POSIX.test(value) ? value : `"${value.replace(/\\/g, '\\\\')}"`;
}

// One hook command line. On Windows the documented `shell: "powershell"` field is set, so Claude Code runs the
// command in PowerShell regardless of whether Git Bash is installed. The absolute node path avoids depending on PATH.
//
// `node` is the executable that runs the capture script. With `runAsNode: true` that executable may be an Electron
// binary (the application's own, when the user has no node on PATH): the command then sets ELECTRON_RUN_AS_NODE=1 for
// this one invocation so Electron behaves as plain Node. The variable is set inside the command, never globally.
//   POSIX / WSL   ELECTRON_RUN_AS_NODE=1 "<exe>" "<capture>" --spool ...
//   Windows       $env:ELECTRON_RUN_AS_NODE='1'; & "<exe>" "<capture>" --spool ...      (runs in PowerShell)
// Without `runAsNode` the output is exactly what it always was.
export function hookCommand({ env, node, capture, spool, registry, handler, event, runAsNode }) {
  const parts = { node, capture, spool, registry, handler, event, env };
  for (const [k, v] of Object.entries(parts)) if (typeof v !== 'string' || v === '') throw new Error(`hookCommand: ${k} required`);
  if (runAsNode !== undefined && typeof runAsNode !== 'boolean') throw new Error('hookCommand: runAsNode must be a boolean');
  if (env === 'win') {
    for (const [k, v] of Object.entries({ node, capture, spool, registry })) {
      if (FORBIDDEN_IN_PS.test(v)) throw new Error(`path for ${k} contains a character that is unsafe inside a PowerShell string: ${v}`);
    }
    const h = hookToken('handler', handler, true); const e = hookToken('event', event, true);
    const q = (s) => `"${s}"`;
    const asNode = runAsNode ? "$env:ELECTRON_RUN_AS_NODE='1'; " : '';
    return { type: 'command', shell: 'powershell', timeout: 5,
      command: `${asNode}& ${q(node)} ${q(capture)} --spool ${q(spool)} --registry ${q(registry)} --env win --handler ${h} ${e}` };
  }
  for (const [k, v] of Object.entries({ node, capture, spool, registry })) {
    if (/["\r\n]/.test(v) || v.includes('$') || v.includes('`')) throw new Error(`path for ${k} contains a character that is unsafe inside a shell string: ${v}`);
  }
  const envToken = hookToken('env', env, false); const h = hookToken('handler', handler, false); const e = hookToken('event', event, false);
  const q = (s) => `"${s}"`;
  const asNode = runAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return { type: 'command', timeout: 5,
    command: `${asNode}${q(node)} ${q(capture)} --spool ${q(spool)} --registry ${q(registry)} --env ${envToken} --handler ${h} ${e}` };
}

// handlers: ['h1'] for normal use, ['h1','h2'] for qualification (every event is then delivered twice on purpose).
// runAsNode: see hookCommand; applied to every registration.
export function buildSettings({ env, node, capture, spool, registry, handlers = ['h1'], runAsNode }) {
  const hooks = {};
  for (const event of EVENTS) {
    hooks[event] = [{ hooks: handlers.map((handler) => hookCommand({ env, node, capture, spool, registry, handler, event, runAsNode })) }];
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
