#!/usr/bin/env node
// A deterministic stand-in for the `claude` CLI, used by the integration and acceptance tests. Plain Node ESM, no
// dependencies. It behaves like the real CLI (2.1.314) wherever Mini-Summa depends on it:
//
//   claude --version                      -> "2.1.314 (Claude Code)"
//   claude agents --json [--all] [--cwd]  -> the JSON array the real CLI prints (live sessions + simulated externals)
//   claude [options]  (stdin is a TTY)    -> an interactive session: raw-mode input with bracketed paste, hooks run for
//                                            real from --settings (and the config dir's settings.json), a permission
//                                            dialog that waits for Enter / Esc, report markers, SessionEnd on exit.
//
// Everything it records goes under the state directory <state>:
//   live/<pid>.json                 registration of a running session (status idle|busy|waiting); listed by `agents`
//                                   only while the pid is alive
//   externals.json                  array of extra `agents --json` entries (sessions "started elsewhere"); never filtered
//   received-<sessionId>.jsonl      one {text, at} per submitted prompt, EXACTLY as typed (multi-line preserved)
//   context-<sessionId>.txt         additionalContext returned by SessionStart hooks (exists iff the latest start had one)
//   hooks-<sessionId>.jsonl         one line per hook command that ran: {event, command, code, timedOut, ms}
//   size-<sessionId>.json           the terminal size the session sees (updated on resize)
//   env-<sessionId>.json            names of the environment variables it was started with, plus TERM, COLORTERM and
//                                   CLAUDE_CONFIG_DIR (values of nothing else: tests check what was passed on or removed)
//   config/projects/<dir>/<id>.jsonl  the transcript (created at the first prompt: only then does --resume find it).
//                                   Under $CLAUDE_CONFIG_DIR instead of <state>/config when that variable is set; its
//                                   settings.json hooks run too, as the user-level hooks of the real CLI do.
//
// Directives in a prompt steer the "model": [[fake:tool bash "echo hi"]], [[fake:permission]], [[fake:input]],
// [[fake:report status=complete task="Fix login"]], [[fake:error]], [[fake:sleep=300]], [[fake:say "text"]],
// [[fake:crash]]. Without a directive the reply echoes the prompt and the turn ends with a plain Stop (no marker).
//
// The conversation can be replaced INSIDE the running process, as in the real CLI: typing /clear, or /resume <session id>, or a
// directive [[fake:clear]] / [[fake:resume=<session id>]] in a prompt. Observed on the real CLI 2.1.314: SessionEnd (old id,
// reason "clear" or "resume") and then SessionStart (new id, source "clear" without `model`, or "resume" with it), and
// `claude agents --json` lists the new id with the SAME pid. The fake does the same; the turn that triggered a directive ends
// without a Stop (the old session is over). FAKE_CLAUDE_REGISTRY_LAG_MS (default 0) delays the moment `agents --json` shows the new
// id, to test the window in which only the hooks know about it.
//
// <state> is `--fake-state-dir <dir>` (anywhere in the arguments; fakeClaudeCommand() puts it in prefixArgs, so several
// fakes with different directories can run in one process) or else $FAKE_CLAUDE_STATE_DIR.
//
// Knobs (environment): FAKE_CLAUDE_THINK_MS (default 120, pause before a turn acts), FAKE_CLAUDE_NOTIFY_MS (default
// 6000, delay of the permission_prompt Notification, as observed on the real CLI), FAKE_CLAUDE_IDLE_NOTIFY_MS (default 0 =
// off, idle_prompt Notification after that long idle), FAKE_CLAUDE_PASTE_WRAP=0 (report pasted prompts verbatim; by default
// a bracketed paste of 3+ line breaks is shown as "[Pasted text #1 +N lines]" and reported in UserPromptSubmit wrapped in
// <pasted_content> tags, as the real CLI does).
//
// What is copied from the real CLI (2.1.314, see packages/core/test/claude/REAL-CLAUDE-RUNS.md): the field sets of the hook
// payloads, the permission dialog and its numbering (Enter/1/2/3 approve, Esc/4 reject), Esc = "Interrupted" with no Stop, the
// ~6 s delay of the permission_prompt Notification, a resumed SessionStart without `model` but with context_tokens and friends,
// "No conversation found with session ID" for a session that was never prompted, SessionEnd before the exit. What is invented:
// the banner, the text of the elicitation dialog, the reply text, and everything a model would do.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2.1.314';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const DOUBLE_PRESS_MS = 800;
const intEnv = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
// Observed on the real CLI (2.1.314, packages/core/test/claude/REAL-CLAUDE-RUNS.md): a bracketed paste of 4 lines is shown
// as "[Pasted text #1 +3 lines]" and submitted wrapped as "\n\n<pasted_content id=\"N\">\n...\n</pasted_content id=\"N\">\n";
// a paste of 2 lines arrives verbatim. The exact threshold is unknown; 3 newlines is the smallest size seen wrapped.
const PASTE_WRAP = process.env.FAKE_CLAUDE_PASTE_WRAP !== '0';
const PASTE_WRAP_MIN_NEWLINES = 3;
const PASTE_ID_BASE = 4097;
const PASTE_OPEN = '\uE000';     // private-use markers that stand for a collapsed paste inside the input buffer
const PASTE_CLOSE = '\uE001';
const THINK_MS = intEnv('FAKE_CLAUDE_THINK_MS', 120);
const NOTIFY_MS = intEnv('FAKE_CLAUDE_NOTIFY_MS', 6000);
const IDLE_NOTIFY_MS = intEnv('FAKE_CLAUDE_IDLE_NOTIFY_MS', 0);
const REGISTRY_LAG_MS = intEnv('FAKE_CLAUDE_REGISTRY_LAG_MS', 0);

// ---------------------------------------------------------------------------------------------------------------
// Command line

// name -> how many values it takes: 0, 1, 'optional' (one, unless the next token is an option) or 'variadic'.
const OPTIONS = {
  '--session-id': 1, '--resume': 'optional', '-r': 'optional', '--settings': 1, '--name': 1, '-n': 1,
  '--remote-control': 'optional', '--rc': 'optional', '--model': 1, '--permission-mode': 1, '--effort': 1,
  '--add-dir': 'variadic', '--allowedTools': 'variadic', '--allowed-tools': 'variadic',
  '--disallowedTools': 'variadic', '--disallowed-tools': 'variadic', '--tools': 'variadic',
  '--mcp-config': 'variadic', '--betas': 'variadic', '--file': 'variadic',
  '--append-system-prompt': 1, '--system-prompt': 1, '--agent': 1, '--agents': 1, '--fallback-model': 1,
  '--setting-sources': 1, '--plugin-dir': 1, '--plugin-url': 1, '--debug-file': 1, '--output-format': 1,
  '--input-format': 1, '--max-budget-usd': 1, '--json-schema': 1, '--permission-prompts': 1,
  '--debug': 'optional', '-d': 'optional', '--worktree': 'optional', '-w': 'optional', '--from-pr': 'optional',
  '--continue': 0, '-c': 0, '--print': 0, '-p': 0, '--verbose': 0, '--fork-session': 0, '--strict-mcp-config': 0,
  '--dangerously-skip-permissions': 0, '--allow-dangerously-skip-permissions': 0, '--bare': 0, '--safe-mode': 0,
  '--chrome': 0, '--no-chrome': 0, '--ide': 0, '--brief': 0, '--bg': 0, '--background': 0, '--restricted': 0,
  '--disable-slash-commands': 0, '--no-session-persistence': 0, '--include-partial-messages': 0,
  '--include-hook-events': 0, '--replay-user-messages': 0, '--tmux': 0, '--ax-screen-reader': 0,
  '--version': 0, '-v': 0, '--help': 0, '-h': 0, '--json': 0, '--all': 0, '--cwd': 1,
};
const SUBCOMMANDS = new Set(['agents', 'auth', 'doctor', 'mcp', 'plugin', 'plugins', 'install', 'update', 'upgrade', 'attach', 'logs', 'stop', 'kill', 'rm', 'respawn', 'purge', 'import', 'gateway', 'setup-token', 'ultrareview', 'auto-mode']);

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = new Map();
  const positionals = [];
  let subcommand = null;
  for (let i = 0; i < argv.length; i++) {
    let token = argv[i];
    if (token === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!token.startsWith('-') || token === '-') {
      if (subcommand === null && positionals.length === 0 && SUBCOMMANDS.has(token)) subcommand = token;
      else positionals.push(token);
      continue;
    }
    let inline = null;
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    if (eq > 0) { inline = token.slice(eq + 1); token = token.slice(0, eq); }
    if (!(token in OPTIONS)) fail(`error: unknown option '${token}'`);
    const arity = OPTIONS[token];
    const values = [];
    if (inline !== null) values.push(inline);
    else if (arity === 1) {
      if (i + 1 >= argv.length) fail(`error: option '${token}' argument missing`);
      values.push(argv[++i]);
    } else if (arity === 'optional') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) values.push(argv[++i]);
    } else if (arity === 'variadic') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) values.push(argv[++i]);
      if (values.length === 0) fail(`error: option '${token}' argument missing`);
    }
    const prior = options.get(token) ?? [];
    options.set(token, [...prior, ...values]);
  }
  const get = (...names) => { for (const n of names) if (options.has(n)) return options.get(n); return undefined; };
  return { options, positionals, subcommand, has: (...n) => n.some((x) => options.has(x)), first: (...n) => get(...n)?.[0] ?? null };
}

// ---------------------------------------------------------------------------------------------------------------
// State directory helpers

// The state directory comes from `--fake-state-dir <dir>` (what fakeClaudeCommand() puts in prefixArgs, so several fakes
// with different directories can coexist in one process) or else from $FAKE_CLAUDE_STATE_DIR.
const ARGV = process.argv.slice(2);
let stateDirArg = null;
for (let i = 0; i < ARGV.length; i++) {
  if (ARGV[i] === '--fake-state-dir' && i + 1 < ARGV.length) { stateDirArg = ARGV[i + 1]; ARGV.splice(i, 2); break; }
  if (ARGV[i].startsWith('--fake-state-dir=')) { stateDirArg = ARGV[i].slice('--fake-state-dir='.length); ARGV.splice(i, 1); break; }
}
const STATE_DIR = stateDirArg ? path.resolve(stateDirArg) : process.env.FAKE_CLAUDE_STATE_DIR || null;
const requireStateDir = () => {
  if (!STATE_DIR) fail('fake-claude: no state directory. Pass --fake-state-dir <dir> or set FAKE_CLAUDE_STATE_DIR to the directory the test uses for this fake CLI.', 2);
  return STATE_DIR;
};
const liveDir = () => path.join(requireStateDir(), 'live');
const stateFile = (name) => path.join(requireStateDir(), name);
const CONFIG_DIR = () => process.env.CLAUDE_CONFIG_DIR || path.join(requireStateDir(), 'config');

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};
const encodeDir = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');
const toolUseId = () => `toolu_${randomBytes(12).toString('base64url').replace(/[-_]/g, 'x').slice(0, 24)}`;

// ---------------------------------------------------------------------------------------------------------------
// agents --json

function commandAgents(parsed) {
  if (!parsed.has('--json')) fail('The fake claude supports only: agents --json [--all] [--cwd <path>]');
  const list = [];
  const dir = liveDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* no sessions yet */ }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const file = path.join(dir, name);
    const entry = readJson(file, null);
    if (!entry) continue;
    if (pidAlive(entry.pid)) list.push(entry);
    else { try { fs.unlinkSync(file); } catch { /* another reader got it */ } }
  }
  const externals = readJson(stateFile('externals.json'), []);
  if (Array.isArray(externals)) list.push(...externals);
  const under = parsed.first('--cwd');
  const root = under ? path.resolve(under) : null;
  const shown = root ? list.filter((e) => typeof e.cwd === 'string' && (e.cwd === root || e.cwd.startsWith(root + path.sep))) : list;
  process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------
// Hook payload templates: the REAL captured payloads, loaded from the integration package's examples

const TEMPLATE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
// Used only when the examples directory cannot be found (the fake copied somewhere else): same key sets as the real ones.
const FALLBACK_TEMPLATES = {
  SessionStart: { session_id: '', transcript_path: '', cwd: '', scratchpad_dir: '', hook_event_name: 'SessionStart', source: 'startup', model: '', session_title: '' },
  UserPromptSubmit: { session_id: '', transcript_path: '', cwd: '', prompt_id: '', permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: '' },
  PermissionRequest: { session_id: '', transcript_path: '', cwd: '', prompt_id: '', permission_mode: 'default', effort: { level: 'high' }, hook_event_name: 'PermissionRequest', tool_name: '', tool_input: {}, permission_suggestions: [] },
  PreToolUse: { session_id: '', transcript_path: '', cwd: '', prompt_id: '', permission_mode: 'default', effort: { level: 'high' }, hook_event_name: 'PreToolUse', tool_name: '', tool_input: {}, tool_use_id: '' },
  PostToolUse: { session_id: '', transcript_path: '', cwd: '', prompt_id: '', permission_mode: 'default', effort: { level: 'high' }, hook_event_name: 'PostToolUse', tool_name: '', tool_input: {}, tool_response: {}, tool_use_id: '', duration_ms: 0 },
  Notification: { session_id: '', transcript_path: '', cwd: '', scratchpad_dir: '', prompt_id: '', hook_event_name: 'Notification', message: '', notification_type: '' },
  Stop: { session_id: '', transcript_path: '', cwd: '', prompt_id: '', permission_mode: 'default', effort: { level: 'high' }, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '', background_tasks: [], session_crons: [] },
  SessionEnd: { session_id: '', transcript_path: '', cwd: '', scratchpad_dir: '', prompt_id: '', hook_event_name: 'SessionEnd', reason: '' },
};

function loadTemplates() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = process.env.FAKE_CLAUDE_TEMPLATES_DIR || path.resolve(here, '../../../../claude-integration/examples/captured-hooks');
  const templates = {};
  for (const event of TEMPLATE_EVENTS) {
    const file = readJson(path.join(dir, `${event}.json`), null);
    templates[event] = file && file.payload ? file.payload : FALLBACK_TEMPLATES[event];
  }
  // No real StopFailure was captured; it is a Stop without the Stop-only fields plus the documented error fields.
  const { stop_hook_active: _a, background_tasks: _b, session_crons: _c, ...rest } = templates.Stop;
  templates.StopFailure = { ...rest, hook_event_name: 'StopFailure', error: '', error_details: '' };
  return templates;
}

// ---------------------------------------------------------------------------------------------------------------
// Hooks: run the real commands from settings exactly as Claude Code does

const MATCHER_FIELD = { SessionStart: 'source', Notification: 'notification_type', SessionEnd: 'reason', PreToolUse: 'tool_name', PostToolUse: 'tool_name', PermissionRequest: 'tool_name' };

function readSettingsSource(spec, cwd) {
  if (!spec) return null;
  if (spec.trim().startsWith('{')) return JSON.parse(spec);
  return JSON.parse(fs.readFileSync(path.resolve(cwd, spec), 'utf8'));
}

function loadHookSources(settingsArg, cwd) {
  const sources = [
    readJson(path.join(CONFIG_DIR(), 'settings.json'), null),
    readJson(path.join(cwd, '.claude', 'settings.json'), null),
    readJson(path.join(cwd, '.claude', 'settings.local.json'), null),
  ];
  if (settingsArg) {
    try { sources.push(readSettingsSource(settingsArg, cwd)); } catch (err) { fail(`Error: could not read settings from ${settingsArg}: ${err.message}`); }
  }
  return sources.filter((s) => s && typeof s === 'object');
}

function hooksFor(sources, event, payload) {
  const seen = new Set();
  const found = [];
  const field = MATCHER_FIELD[event];
  for (const source of sources) {
    for (const group of source.hooks?.[event] ?? []) {
      if (group.matcher && group.matcher !== '*' && field) {
        const value = String(payload[field] ?? '');
        try { if (!new RegExp(`^(?:${group.matcher})$`).test(value)) continue; } catch { continue; }
      }
      for (const hook of group.hooks ?? []) {
        if (hook?.type !== 'command' || typeof hook.command !== 'string') continue;
        const id = `${hook.shell ?? ''}\u0000${hook.command}`;
        if (seen.has(id)) continue;                 // identical commands run once, as on the real CLI
        seen.add(id);
        found.push(hook);
      }
    }
  }
  return found;
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');          // the hook runs in its own process group (detached)
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

function runHookCommand(hook, payload, cwd) {
  const started = Date.now();
  const timeoutMs = (Number.isFinite(hook.timeout) ? hook.timeout : 60) * 1000;
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
    const options = { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' };
    const child = hook.shell === 'powershell'
      ? spawn(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', hook.command], options)
      : spawn(hook.command, { ...options, shell: true });
    let stdout = '';
    let timedOut = false;
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, timedOut, ms: Date.now() - started });
    };
    // On timeout the whole process tree is killed and the hook is reported as timed out without waiting for its pipes.
    const timer = setTimeout(() => { timedOut = true; killTree(child); finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < 1_000_000) stdout += d; });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
    child.stdin.end(JSON.stringify(payload));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Directives

function parseDirectives(text) {
  const out = [];
  for (const m of text.matchAll(/\[\[fake:([^\]]*)\]\]/g)) {
    const tokens = [...m[1].trim().matchAll(/(?:[A-Za-z_]+=)?"[^"]*"|\S+/g)].map((t) => t[0]);
    const head = tokens.shift() ?? '';
    const eq = head.indexOf('=');
    const name = (eq >= 0 ? head.slice(0, eq) : head).toLowerCase();
    const inline = eq >= 0 ? head.slice(eq + 1) : null;
    const named = {};
    const positional = [];
    for (const token of tokens) {
      let kv = /^([A-Za-z_]+)="([^"]*)"$/.exec(token);                 // key="quoted value"
      if (kv) { named[kv[1]] = kv[2]; continue; }
      const quoted = /^"([^"]*)"$/.exec(token);                         // "quoted positional": never a key=value
      if (quoted) { positional.push(quoted[1]); continue; }
      kv = /^([A-Za-z_]+)=(.*)$/.exec(token);                          // key=value
      if (kv) named[kv[1]] = kv[2]; else positional.push(token);
    }
    out.push({ name, inline, named, positional });
  }
  return out;
}

const normalizeToolName = (name) => ({ bash: 'Bash', write: 'Write', read: 'Read', edit: 'Edit' }[name.toLowerCase()] ?? name);

function toolInputFor(toolName, positional) {
  if (toolName === 'Bash') return { command: positional[0] ?? 'echo fake-tool', description: positional[0] ?? 'echo fake-tool' };
  if (toolName === 'Write') return { file_path: positional[0] ?? 'fake-output.txt', content: positional[1] ?? 'fake' };
  if (toolName === 'Read') return { file_path: positional[0] ?? 'README.md' };
  return { args: positional };
}

// ---------------------------------------------------------------------------------------------------------------
// The interactive session

class Interrupted extends Error {}
/** The conversation was replaced during a turn (a [[fake:clear]] / [[fake:resume]] directive): the turn ends with no Stop. */
class Switched extends Error {}

async function runInteractive(parsed) {
  if (!process.stdin.isTTY) {
    fail('Error: Input must be provided either through stdin or as a prompt argument when using --print');
  }
  requireStateDir();
  const cwd = process.cwd();
  const templates = loadTemplates();
  const configDir = CONFIG_DIR();

  // Session identity
  let sessionId;
  let source = 'startup';
  let name = parsed.first('--name', '-n');
  const resumeRequested = parsed.has('--resume', '-r');
  const explicitId = parsed.first('--session-id');
  const findTranscript = (id) => {
    const projects = path.join(configDir, 'projects');
    try {
      for (const d of fs.readdirSync(projects)) {
        const file = path.join(projects, d, `${id}.jsonl`);
        if (fs.existsSync(file)) return file;
      }
    } catch { /* no projects yet */ }
    return null;
  };
  if (resumeRequested) {
    const value = parsed.first('--resume', '-r');
    if (!value) fail('The fake claude cannot open the interactive session picker. Pass --resume <session-id>.');
    if (!UUID_RE.test(value)) fail(`No conversation found with session ID: ${value}`);
    if (!findTranscript(value)) fail(`No conversation found with session ID: ${value}`);
    sessionId = value.toLowerCase();
    source = 'resume';
    if (!name) {
      try {
        const first = fs.readFileSync(findTranscript(value), 'utf8').split('\n', 1)[0];
        name = JSON.parse(first).name ?? null;
      } catch { /* an unnamed session */ }
    }
  } else if (explicitId) {
    if (!UUID_RE.test(explicitId)) fail('Error: Invalid session ID. Must be a valid UUID.');
    sessionId = explicitId.toLowerCase();
  } else {
    sessionId = randomUUID();
  }

  const S = {
    sessionId, registeredId: sessionId, inProcess: false, switching: false, name, cwd, source,
    model: parsed.first('--model') ?? 'claude-fake-1',
    permissionMode: ({ manual: 'default' })[parsed.first('--permission-mode')] ?? parsed.first('--permission-mode') ?? (parsed.has('--dangerously-skip-permissions') ? 'bypassPermissions' : 'default'),
    remoteControl: parsed.has('--remote-control', '--rc'),
    startedAt: Date.now(),
    transcriptPath: path.join(configDir, 'projects', encodeDir(cwd), `${sessionId}.jsonl`),
    scratchpadDir: path.join(os.tmpdir(), `claude-${process.getuid ? process.getuid() : 0}`, encodeDir(cwd), sessionId, 'scratchpad'),
    promptId: null,
    status: 'idle',
    waitingFor: null,
    ready: false,
    exiting: false,
    turn: null,
    queue: [],
    buffer: '',                   // typed text; a collapsed paste is PASTE_OPEN <id> PASTE_CLOSE
    pastes: new Map(),
    inputMode: 'prompt',          // prompt | dialog | question
    dialogResolve: null,
    answer: '',
    lastCtrlC: 0,
    background: new Set(),
    idleTimer: null,
  };
  const sources = loadHookSources(parsed.first('--settings'), cwd);
  const liveFile = path.join(liveDir(), `${process.pid}.json`);
  const out = (text) => process.stdout.write(text);

  // --- registration, status
  const registration = () => {
    const entry = { pid: process.pid, cwd, kind: 'interactive', startedAt: S.startedAt, sessionId: S.registeredId, status: S.status };
    if (S.name) entry.name = S.name;
    if (S.waitingFor) entry.waitingFor = S.waitingFor;
    if (S.remoteControl) entry.remoteControl = true;
    return entry;
  };
  const publish = () => { try { writeJsonAtomic(liveFile, registration()); } catch { /* state dir vanished */ } };
  const setStatus = (status, waitingFor = null) => { S.status = status; S.waitingFor = waitingFor; publish(); };
  const unregister = () => { try { fs.unlinkSync(liveFile); } catch { /* already gone */ } };
  const writeSize = () => {
    const size = { cols: process.stdout.columns ?? null, rows: process.stdout.rows ?? null };
    try { writeJsonAtomic(stateFile(`size-${sessionId}.json`), size); } catch { /* ignore */ }
    return size;
  };

  // --- hooks
  const payloadFor = (event, extra) => {
    const template = structuredClone(templates[event] ?? { hook_event_name: event });
    const known = {
      session_id: sessionId, transcript_path: S.transcriptPath, cwd, scratchpad_dir: S.scratchpadDir,
      prompt_id: S.promptId ?? undefined, permission_mode: S.permissionMode, effort: { level: 'high' },
      hook_event_name: event, model: S.model, session_title: S.name ?? undefined, source: S.source,
    };
    const payload = {};
    for (const key of Object.keys(template)) payload[key] = key in known ? known[key] : template[key];
    Object.assign(payload, extra);
    // Observed on the real CLI: the SessionStart of a /clear has no `model`.
    if (event === 'SessionStart' && S.source === 'clear') delete payload.model;
    if (event === 'SessionStart' && S.source === 'resume') {
      // Observed on the real CLI: a resumed start (`--resume`) has no `model` and carries these numeric fields instead; the
      // /resume typed inside a running session keeps the model and carries them as well.
      if (!S.inProcess) delete payload.model;
      let bytes = 0;
      let idleSeconds = 0;
      try { const st = fs.statSync(S.transcriptPath); bytes = st.size; idleSeconds = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000)); } catch { /* no transcript yet */ }
      Object.assign(payload, {
        seconds_since_last_response: idleSeconds, context_tokens: Math.round(bytes / 4), prompt_cache_likely_expired: idleSeconds > 300, estimated_cache_write_usd: 0.0072,
      });
    }
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    return payload;
  };
  const fireHook = async (event, extra = {}) => {
    const payload = payloadFor(event, extra);
    const hooks = hooksFor(sources, event, payload);
    const results = await Promise.all(hooks.map(async (hook) => {
      const result = await runHookCommand(hook, payload, cwd);
      try {
        fs.appendFileSync(stateFile(`hooks-${sessionId}.jsonl`), `${JSON.stringify({ event, command: hook.command, code: result.code, timedOut: result.timedOut, ms: result.ms })}\n`);
      } catch { /* ignore */ }
      return result;
    }));
    return results;
  };
  const fireInBackground = (event, extra) => {
    const p = fireHook(event, extra).catch(() => {}).finally(() => S.background.delete(p));
    S.background.add(p);
    return p;
  };
  const recordSessionStartContext = (results) => {
    const contexts = [];
    for (const r of results) {
      try {
        const parsedOut = JSON.parse(r.stdout);
        const ctx = parsedOut?.hookSpecificOutput?.additionalContext;
        if (typeof ctx === 'string' && ctx !== '') contexts.push(ctx);
      } catch { /* not JSON: plain-text stdout is not recorded */ }
    }
    const file = stateFile(`context-${sessionId}.txt`);
    if (contexts.length) fs.writeFileSync(file, contexts.join('\n\n'));
    else { try { fs.unlinkSync(file); } catch { /* none */ } }
  };

  // --- transcript
  const transcript = (entry) => {
    try {
      fs.mkdirSync(path.dirname(S.transcriptPath), { recursive: true });
      const lines = [];
      if (!fs.existsSync(S.transcriptPath) && S.name) lines.push({ type: 'session', name: S.name });
      lines.push(entry);
      fs.appendFileSync(S.transcriptPath, lines.map((l) => `${JSON.stringify({ ...l, sessionId, cwd, timestamp: new Date().toISOString() })}\n`).join(''));
    } catch { /* ignore */ }
  };

  // --- replacing the conversation inside the running process (/clear, /resume <id>)
  const switchSession = async (kind, targetId) => {
    S.switching = true;
    try {
      await fireHook('SessionEnd', { reason: kind });
      const nextId = (kind === 'resume' ? targetId : randomUUID()).toLowerCase();
      sessionId = nextId;
      S.sessionId = nextId;
      S.source = kind;
      S.inProcess = true;
      S.transcriptPath = path.join(configDir, 'projects', encodeDir(cwd), `${sessionId}.jsonl`);
      S.scratchpadDir = path.join(os.tmpdir(), `claude-${process.getuid ? process.getuid() : 0}`, encodeDir(cwd), sessionId, 'scratchpad');
      if (kind === 'clear') S.promptId = null;
      writeSize();
      writeJsonAtomic(stateFile(`env-${sessionId}.json`), {
        names: Object.keys(process.env).sort(),
        TERM: process.env.TERM ?? null, COLORTERM: process.env.COLORTERM ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
      });
      // The registry that `agents --json` reads follows at once (or after FAKE_CLAUDE_REGISTRY_LAG_MS).
      const register = () => { S.registeredId = nextId; publish(); };
      if (REGISTRY_LAG_MS > 0) { const t = setTimeout(register, REGISTRY_LAG_MS); t.unref?.(); } else register();
      out(`\n${accent('✻')} ${kind === 'clear' ? 'Conversation cleared' : 'Conversation resumed'}  ${dim('session:')} ${sessionId}\n`);
      const results = await fireHook('SessionStart', {});
      recordSessionStartContext(results);
    } finally { S.switching = false; }
  };
  const resumable = (id) => UUID_RE.test(id) && Boolean(findTranscript(id));
  const runCommand = async (command) => {
    if (command.kind === 'clear') { await switchSession('clear'); return; }
    if (!resumable(command.id)) { out(`\n  ⎿  ${dim(`No conversation found with session ID: ${command.id}`)}\n`); return; }
    await switchSession('resume', command.id.toLowerCase());
  };

  // --- tools
  const runBash = (command, signal) => new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const kill = () => child.kill('SIGKILL');
    signal.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, 30_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', kill); resolve({ stdout, stderr, interrupted: signal.aborted, isImage: false, noOutputExpected: false }); };
    child.on('error', done);
    child.on('close', done);
  });
  const execTool = async (toolName, input, signal) => {
    if (toolName === 'Bash') return runBash(input.command, signal);
    if (toolName === 'Write') {
      const file = path.resolve(cwd, input.file_path);
      const existed = fs.existsSync(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, input.content);
      return { type: existed ? 'update' : 'create', filePath: file, content: input.content, structuredPatch: [], originalFile: null, userModified: false };
    }
    if (toolName === 'Read') {
      let content = '';
      try { content = fs.readFileSync(path.resolve(cwd, input.file_path), 'utf8'); } catch { /* missing file reads as empty */ }
      return { type: 'text', file: { filePath: path.resolve(cwd, input.file_path), content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } };
    }
    return {};
  };

  // --- terminal output
  const bold = (s) => `\x1b[1m${s}\x1b[22m`;
  const dim = (s) => `\x1b[2m${s}\x1b[22m`;
  const accent = (s) => `\x1b[38;5;209m${s}\x1b[39m`;
  const pasteLabel = (id) => `[Pasted text #${id} +${(S.pastes.get(id).match(/\n/g) ?? []).length} lines]`;
  const render = (raw) => raw.replace(/\uE000(\d+)\uE001/g, (_, id) => pasteLabel(Number(id)));
  const showPrompt = () => out(`\n${accent('>')} ${render(S.buffer)}`);
  const say = (text) => out(`\n${accent('●')} ${text.replace(/\n/g, '\n  ')}\n`);

  // --- turns
  const sleepAbortable = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Interrupted());
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Interrupted()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  // A dialog is on screen and takes keys at once, but an answer is only ACTED ON after the hook announcing the dialog has
  // finished (its spool file is written). Otherwise a fast answer could land in the log before the question it answers.
  const openDialog = (mode, waitingFor, announce, signal) => new Promise((resolve, reject) => {
    let decided = false;
    S.inputMode = mode;
    setStatus('waiting', waitingFor);
    const announced = announce();
    const close = () => { S.inputMode = 'prompt'; S.dialogResolve = null; signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { close(); reject(new Interrupted()); };
    signal.addEventListener('abort', onAbort, { once: true });
    S.dialogResolve = (answer) => {
      if (decided) return;
      decided = true;
      void announced.then(() => {
        if (signal.aborted) return;
        close();
        setStatus('busy');
        resolve(answer);
      });
    };
  });

  const askPermission = (toolName, input, signal) => {
    const shown = toolName === 'Bash' ? input.command : JSON.stringify(input);
    // Layout and numbering as seen on the real CLI (2.1.314, manual mode).
    out(`\n${dim('────────────────────────────────────────────')}\n ${bold(toolName === 'Bash' ? 'Bash command' : `${toolName} request`)}\n\n   ${input.description ?? shown}\n   ${dim('╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌')}\n   ${shown}\n   ${dim('╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌')}\n Do you want to proceed?\n ${accent('❯')} 1. Yes\n   2. Yes, and always allow access to ${cwd} from this project\n   3. Yes, and switch to auto mode · auto mode handles these prompts for you\n   4. No\n\n Esc to cancel · Tab to amend\n`);
    // Real CLI: the Notification follows the PermissionRequest by about 6 s, only if the dialog is still open.
    const notifyTimer = setTimeout(() => {
      if (S.inputMode === 'dialog') fireInBackground('Notification', { message: 'Claude needs your permission', notification_type: 'permission_prompt' });
    }, NOTIFY_MS);
    notifyTimer.unref?.();
    const announce = () => fireHook('PermissionRequest', {
      tool_name: toolName,
      tool_input: input,
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName, ruleContent: String(shown).slice(0, 60) }], behavior: 'allow', destination: 'localSettings' }],
    });
    return openDialog('dialog', 'permission prompt', announce, signal).finally(() => clearTimeout(notifyTimer));
  };

  const askQuestion = (question, signal) => {
    S.answer = '';
    out(`\n${bold('Claude has a question')}\n  ${question}\n${accent('>')} `);
    return openDialog('question', 'input needed', () => fireHook('Notification', { message: 'Claude has a question for you', notification_type: 'elicitation_dialog' }), signal);
  };

  const useTool = async (toolName, input, { permission }, signal) => {
    const id = toolUseId();
    await fireHook('PreToolUse', { tool_name: toolName, tool_input: input, tool_use_id: id });
    if (signal.aborted) throw new Interrupted();
    out(`\n${accent('●')} ${bold(toolName)}(${toolName === 'Bash' ? input.command : JSON.stringify(input)})\n`);
    if (permission && S.permissionMode !== 'bypassPermissions') {
      const decision = await askPermission(toolName, input, signal);
      if (decision === 'reject') throw new Interrupted();
    }
    const started = Date.now();
    const response = await execTool(toolName, input, signal);
    if (signal.aborted) throw new Interrupted();
    if (toolName === 'Bash' && response.stdout) out(`  ⎿  ${response.stdout.trimEnd().replace(/\n/g, '\n     ')}\n`);
    await fireHook('PostToolUse', { tool_name: toolName, tool_input: input, tool_response: response, tool_use_id: id, duration_ms: Date.now() - started });
  };

  const reportBody = (task, status) => [
    `Finished: ${task}.`,
    '',
    '## Implementation Report',
    '',
    '**What changed:** Nothing real. This session is the fake Claude CLI used for tests.',
    '',
    '**Tests run:** None.',
    '',
    '**Unresolved problems:** None.',
    '',
    '**Risks:** None.',
    '',
    '**Recommended next steps:** None.',
    '',
    `<!-- mini-summa:report status=${status} task="${task}" -->`,
  ].join('\n');

  const runTurn = async (entry) => {
    const text = entry.text;
    const controller = new AbortController();
    const signal = controller.signal;
    S.turn = { controller };
    S.promptId = randomUUID();
    setStatus('busy');
    transcript({ type: 'user', message: { role: 'user', content: entry.hookText } });
    try {
      await fireHook('UserPromptSubmit', { prompt: entry.hookText });
      out(`${dim('✻ Thinking… (esc to interrupt)')}\n`);
      await sleepAbortable(THINK_MS, signal);
      let reply = null;
      let failure = null;
      for (const d of parseDirectives(text)) {
        if (signal.aborted) throw new Interrupted();
        switch (d.name) {
          case 'sleep': await sleepAbortable(Number.parseInt(d.inline ?? d.positional[0] ?? '0', 10) || 0, signal); break;
          case 'tool': {
            const toolName = normalizeToolName(d.positional[0] ?? 'bash');
            await useTool(toolName, toolInputFor(toolName, d.positional.slice(1)), { permission: false }, signal);
            break;
          }
          case 'permission': {
            const toolName = normalizeToolName(d.positional[0] ?? 'bash');
            const args = d.positional.length > 1 ? d.positional.slice(1) : toolName === 'Bash' ? ['echo fake-permission'] : [];
            await useTool(toolName, toolInputFor(toolName, args), { permission: true }, signal);
            break;
          }
          case 'input': {
            const answer = await askQuestion(d.positional[0] ?? 'What should I do next?', signal);
            out(`\n${dim(`(answered: ${answer})`)}\n`);
            break;
          }
          case 'report': {
            const status = ['complete', 'partial', 'blocked'].includes(d.named.status) ? d.named.status : 'complete';
            const task = (d.named.task ?? 'Fake task').replace(/["\r\n]/g, ' ').slice(0, 200);
            reply = reportBody(task, status);
            break;
          }
          case 'say': reply = d.positional[0] ?? ''; break;
          case 'clear': await switchSession('clear'); throw new Switched();
          case 'resume': {
            const id = String(d.inline ?? d.positional[0] ?? '');
            if (!resumable(id)) { out(`\n${accent('●')} No conversation found with session ID: ${id}\n`); break; }
            await switchSession('resume', id);
            throw new Switched();
          }
          case 'error': failure = { error: d.named.error ?? 'api_error', error_details: d.named.details ?? '500', message: `API Error: ${d.named.error ?? 'api_error'}` }; break;
          case 'crash': process.exit(Number.parseInt(d.inline ?? '1', 10) || 1); break;
          default: break;
        }
      }
      if (signal.aborted) throw new Interrupted();
      if (failure) {
        out(`\n${accent('●')} ${failure.message}\n`);
        transcript({ type: 'assistant', message: { role: 'assistant', content: failure.message } });
        await fireHook('StopFailure', { error: failure.error, error_details: failure.error_details, last_assistant_message: failure.message });
      } else {
        const message = reply ?? `fake-claude received ${text.length} characters. Echo: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
        say(message);
        transcript({ type: 'assistant', message: { role: 'assistant', content: message } });
        await fireHook('Stop', { stop_hook_active: false, last_assistant_message: message });
      }
    } catch (err) {
      // The conversation was replaced: that session is over, so nothing more is said about this turn.
      if (err instanceof Switched) return;
      if (!(err instanceof Interrupted) && err?.name !== 'AbortError') throw err;
      // An interrupt ends the turn without a Stop, as on the real CLI.
      out(`\n  ⎿  ${dim('Interrupted · What should Claude do instead?')}\n`);
    } finally {
      S.turn = null;
      S.inputMode = 'prompt';
      setStatus('idle');
    }
  };

  const armIdleNotification = () => {
    if (!IDLE_NOTIFY_MS) return;
    clearTimeout(S.idleTimer);
    S.idleTimer = setTimeout(() => {
      if (S.status === 'idle' && !S.exiting) fireInBackground('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
    }, IDLE_NOTIFY_MS);
    S.idleTimer.unref?.();
  };

  let pumping = false;
  const pump = async () => {
    if (pumping || !S.ready || S.exiting) return;
    pumping = true;
    try {
      while (S.queue.length > 0 && !S.exiting) {
        const next = S.queue.shift();
        if (next.command) await runCommand(next.command);
        else await runTurn(next);
        if (S.queue.length === 0) { showPrompt(); armIdleNotification(); }
      }
    } finally { pumping = false; }
  };

  const submit = (text, hookText = text) => {
    if (text.trim() === '') return;
    if (/^\/(exit|quit)\s*$/.test(text.trim())) { void requestExit('prompt_input_exit'); return; }
    if (text.startsWith('/') && !text.includes('\n') && !text.includes('[[fake:')) {
      const command = text.trim();
      const resume = /^\/resume\s+(\S+)$/.exec(command);
      // Like typed input in the real CLI, these wait for the turn that is still running and then run in order.
      if (command === '/clear') { S.queue.push({ command: { kind: 'clear' } }); void pump(); return; }
      if (resume) { S.queue.push({ command: { kind: 'resume', id: resume[1] } }); void pump(); return; }
      out(`\n  ⎿  ${dim(`Unknown command: ${command} (fake-claude knows /exit, /clear and /resume <id>)`)}\n`);
      showPrompt();
      return;
    }
    try { fs.appendFileSync(stateFile(`received-${sessionId}.jsonl`), `${JSON.stringify({ text, at: new Date().toISOString() })}\n`); } catch { /* ignore */ }
    S.queue.push({ text, hookText });
    void pump();
  };

  // --- exit
  const cleanupTty = () => { try { process.stdin.setRawMode(false); } catch { /* not a TTY any more */ } };
  const requestExit = async (reason) => {
    if (S.exiting) return;
    S.exiting = true;
    clearTimeout(S.idleTimer);
    S.turn?.controller.abort();
    out(`\n${dim('Goodbye!')}\n`);
    await fireHook('SessionEnd', { reason });
    await Promise.allSettled([...S.background]);
    unregister();
    cleanupTty();
    process.exit(0);
  };
  // A signal ends the process at once with no SessionEnd, as the real CLI does.
  for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]]) {
    process.on(signal, () => { unregister(); cleanupTty(); process.exit(code); });
  }
  process.on('exit', () => { if (S.exiting) unregister(); });

  // --- keyboard
  const interrupt = () => { S.turn?.controller.abort(); };
  const ctrlC = () => {
    const now = Date.now();
    const second = now - S.lastCtrlC < DOUBLE_PRESS_MS;
    S.lastCtrlC = now;
    if (S.inputMode === 'dialog' || S.inputMode === 'question') { interrupt(); return; }
    if (S.turn) { interrupt(); return; }
    if (second) { void requestExit('prompt_input_exit'); return; }
    if (S.buffer !== '') { S.buffer = ''; out(`${dim('^C')}\n`); showPrompt(); return; }
    out(`\n${dim('Press Ctrl-C again to exit')}\n`);
    showPrompt();
  };
  const escape = () => {
    if (S.inputMode === 'dialog') { S.dialogResolve?.('reject'); return; }
    if (S.inputMode === 'question' || S.turn) interrupt();
  };
  const insert = (text) => {
    if (S.inputMode === 'question') { S.answer += text; out(text); return; }
    S.buffer += text;
    out(text);
  };
  const insertPaste = (raw) => {
    const text = raw.replace(/\r\n?/g, '\n');
    if (!text || S.inputMode === 'dialog') return;
    if (PASTE_WRAP && S.inputMode === 'prompt' && (text.match(/\n/g) ?? []).length >= PASTE_WRAP_MIN_NEWLINES) {
      const id = S.pastes.size + 1;
      S.pastes.set(id, text);
      S.buffer += `${PASTE_OPEN}${id}${PASTE_CLOSE}`;
      out(pasteLabel(id));
    } else insert(text);
  };
  const enter = () => {
    if (S.inputMode === 'dialog') { S.dialogResolve?.('approve'); return; }
    if (S.inputMode === 'question') { out('\n'); S.dialogResolve?.(S.answer); return; }
    const raw = S.buffer;
    out('\n');
    S.buffer = '';
    // `text` is what was typed, byte for byte; `hookText` is what the real CLI reports in UserPromptSubmit.
    const text = raw.replace(/\uE000(\d+)\uE001/g, (_, id) => S.pastes.get(Number(id)) ?? '');
    const hookText = raw.replace(/\uE000(\d+)\uE001/g, (_, id) => {
      const n = PASTE_ID_BASE + Number(id);
      return `\n\n<pasted_content id="${n}">\n${S.pastes.get(Number(id))}\n</pasted_content id="${n}">\n`;
    });
    submit(text, hookText);
  };
  const backspace = () => {
    if (S.inputMode === 'question') { if (S.answer) { S.answer = S.answer.slice(0, -1); out('\b \b'); } return; }
    if (S.inputMode !== 'prompt' || !S.buffer) return;
    if (S.buffer.endsWith(PASTE_CLOSE)) {                       // a collapsed paste is removed as one piece
      const at = S.buffer.lastIndexOf(PASTE_OPEN);
      out('\b \b'.repeat(render(S.buffer.slice(at)).length));
      S.buffer = S.buffer.slice(0, at);
    } else { S.buffer = S.buffer.slice(0, -1); out('\b \b'); }
  };
  const onChar = (ch) => {
    if (S.inputMode === 'dialog') {
      if (ch === '\r' || ch === '\n' || ch === '1' || ch === '2' || ch === '3') S.dialogResolve?.('approve');
      else if (ch === '4') S.dialogResolve?.('reject');
      else if (ch === '\x03') ctrlC();
      return;
    }
    if (ch === '\r' || ch === '\n') return enter();
    if (ch === '\x7f' || ch === '\b') return backspace();
    if (ch === '\x03') return ctrlC();
    if (ch === '\x04') { if (S.buffer === '' && !S.turn) { const second = Date.now() - S.lastCtrlC < DOUBLE_PRESS_MS; S.lastCtrlC = Date.now(); if (second) void requestExit('prompt_input_exit'); else out(`\n${dim('Press Ctrl-D again to exit')}\n`); } return; }
    if (ch === '\x15') { if (S.inputMode === 'prompt') { out('\b \b'.repeat(render(S.buffer).length)); S.buffer = ''; } return; }
    if (ch < ' ') return;
    insert(ch);
  };

  let inPaste = false;
  let pasteAcc = '';
  let carry = '';
  const partialSuffix = (text, marker) => {
    for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) if (marker.startsWith(text.slice(text.length - n))) return n;
    return 0;
  };
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const data = carry + chunk;
    carry = '';
    let i = 0;
    while (i < data.length) {
      if (inPaste) {
        const end = data.indexOf(PASTE_END, i);
        if (end === -1) {
          const keep = partialSuffix(data.slice(i), PASTE_END);
          pasteAcc += data.slice(i, data.length - keep);
          carry = data.slice(data.length - keep);
          break;
        }
        pasteAcc += data.slice(i, end);
        insertPaste(pasteAcc);
        pasteAcc = '';
        inPaste = false;
        i = end + PASTE_END.length;
        continue;
      }
      const ch = data[i];
      if (ch !== '\x1b') { onChar(ch); i += 1; continue; }
      if (data.startsWith(PASTE_START, i)) { inPaste = true; i += PASTE_START.length; continue; }
      const rest = data.slice(i);
      if (rest.length > 1 && rest.length < PASTE_START.length && PASTE_START.startsWith(rest)) { carry = rest; break; }
      const seq = /^\x1b\[[0-9;?<=>]*[ -/]*[@-~]/.exec(rest) || /^\x1bO./.exec(rest);
      if (seq) { i += seq[0].length; continue; }          // arrows, function keys: ignored
      escape();
      i += 1;
    }
  });
  process.stdin.on('end', () => { unregister(); cleanupTty(); process.exit(0); });
  process.stdin.on('error', () => { unregister(); process.exit(0); });
  process.stdin.resume();
  process.stdout.on('resize', () => { const s = writeSize(); out(`\n${dim(`[terminal resized to ${s.cols}x${s.rows}]`)}\n`); });

  // --- start
  fs.mkdirSync(liveDir(), { recursive: true });
  writeSize();
  publish();
  writeJsonAtomic(stateFile(`env-${sessionId}.json`), {
    names: Object.keys(process.env).sort(),
    TERM: process.env.TERM ?? null, COLORTERM: process.env.COLORTERM ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
  });
  out(`\x1b]0;Claude Code${S.name ? ` - ${S.name}` : ''}\x07`);
  out(`${accent('✻')} ${bold('Welcome to Claude Code')} ${dim(`(fake ${VERSION})`)}\n`);
  out(`  ${dim('cwd:')} ${cwd}\n  ${dim('session:')} ${sessionId}${S.name ? `  ${dim('name:')} ${S.name}` : ''}\n  ${dim('model:')} ${S.model}${S.source === 'resume' ? `  ${dim('(resumed)')}` : ''}\n`);
  if (S.remoteControl) out(`  ${dim('Remote Control:')} enabled\n`);
  const startResults = await fireHook('SessionStart', {});
  recordSessionStartContext(startResults);
  S.ready = true;
  out(`\n  ${dim('? for shortcuts')}\n`);
  showPrompt();
  armIdleNotification();
  if (parsed.positionals[0]) submit(parsed.positionals[0]);
  else void pump();
}

// ---------------------------------------------------------------------------------------------------------------
// Entry

const parsed = parseArgs(ARGV);
if (parsed.has('--version', '-v')) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}
if (parsed.has('--help', '-h')) {
  process.stdout.write('Usage: claude [options] [command] [prompt]\n\nThis is the fake Claude CLI used by Mini-Summa tests.\n');
  process.exit(0);
}
if (parsed.subcommand === 'agents') commandAgents(parsed);
else if (parsed.subcommand === 'auth') {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: 'fake', apiProvider: 'firstParty' }, null, 2)}\n`);
  process.exit(0);
} else if (parsed.subcommand) fail(`The fake claude does not implement '${parsed.subcommand}'.`);
else if (parsed.has('--print', '-p')) fail('The fake claude does not implement --print.');
else {
  runInteractive(parsed).catch((err) => {
    process.stderr.write(`fake-claude crashed: ${err?.stack ?? err}\n`);
    process.exit(70);
  });
}
