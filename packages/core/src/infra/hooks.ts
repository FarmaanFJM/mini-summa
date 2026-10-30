// Claude Code hook installer for the USER-LEVEL settings file of an environment (`<configDir>/settings.json`).
//
// It never touches a repository and never needs a CLAUDE.md. Everything is plan first: `plan` computes the exact new
// file text and a diff, `apply` writes only a plan whose hash the caller presents, after saving a backup, and refuses
// (409 plan_stale) if the file changed in between. Mini-Summa only ever adds, replaces or removes its own entries.
//
// A hook is "ours" when it is a command hook whose command contains the capture script's file name and
// `--handler ms-user`. The entries themselves come from the verified builder of the PoC (`buildSettings`), so the
// command lines are the ones the integration tests exercise (POSIX, WSL, and Windows with `shell: "powershell"`).
//
// Local decisions (also in the worker report):
//  * The file is parsed and written back with JSON.stringify using the detected indentation (2, 4 or tab), line ending
//    (LF or CRLF), byte order mark and trailing newline. Values, keys and key order are preserved; a hand-formatted file
//    (for example inline arrays) is re-indented, and the plan says so in `warnings`. Nothing is rewritten when the plan
//    is a noop.
//  * Whitespace-only settings.json counts as an empty object. Anything else that is not a JSON object is refused.
//  * `apply` on a plan that turned into a noop (already in the desired state) succeeds without writing, whatever hash
//    is presented. Otherwise the hash must match the freshly computed plan.
//  * HookPlan.status is the status BEFORE the change. HookPlan.backupPath is '' when no backup is needed.
//  * Uninstall deletes the hook_installs row; install upserts it.
//  * A settings.json reached through a symbolic link (or a linked config folder) is resolved with realpath at plan time.
//    The plan warns with both paths, and warns first of all when the real file is outside the Claude config folder or
//    inside a git work tree. The plan hash covers the resolved target, so `apply` writes only where the plan said and
//    answers 409 plan_stale if the link now leads elsewhere. A dangling link is refused (never replaced by a file).
//  * `<dataDir>/backups` is private: the directory is 0700 and every backup file 0600, whatever the original's mode.
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EVENTS, buildSettings } from '@minisumma/claude-integration';
import { envLabel, isWslEnv } from '@minisumma/shared';
import type { EnvId, HookPlan, HookStatus } from '@minisumma/shared';
import type { CoreBase, EnvLayout, EnvironmentsService, HooksService } from '../contracts.ts';
import { CoreError, conflict, unprocessable } from '../errors.ts';

export const HOOK_HANDLER_ID = 'ms-user';
const HANDLER_RE = /--handler ms-user(?![\w-])/;
const EVENT_LIST: readonly string[] = EVENTS;
const MAX_SETTINGS_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// File access (injectable for tests)

export interface HooksFs {
  /** The file as UTF-8 text with any byte order mark kept, or null when it does not exist. Other failures throw. */
  readText(file: string): Promise<string | null>;
  /** Permission bits of an existing file, or null. */
  statMode(file: string): Promise<number | null>;
  isDirectory(dir: string): Promise<boolean>;
  /** Resolves symlinks so the rename replaces the target and not the link. Returns `file` when it does not exist. */
  realpath(file: string): Promise<string>;
  /** True when `file` itself is a symbolic link (a dangling one included). */
  isSymlink(file: string): Promise<boolean>;
  /** Creates the directory and missing parents. With `mode` the directory ends up with exactly that mode. */
  mkdirp(dir: string, mode?: number): Promise<void>;
  /** Byte-exact copy that is private (0600) from its first byte, whatever the source's mode. Refuses to overwrite. */
  copyFile(from: string, to: string): Promise<void>;
  /** Temp file next to `file`, flushed, then renamed over it. Never leaves a half-written settings file. */
  writeAtomic(file: string, text: string, mode: number): Promise<void>;
  exists(file: string): Promise<boolean>;
}

const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

export const nodeHooksFs: HooksFs = {
  async readText(file) {
    let buf: Buffer;
    try {
      const st = await fsp.stat(file);
      if (st.size > MAX_SETTINGS_BYTES) throw Object.assign(new Error('settings file is larger than 10 MB'), { code: 'EFBIG' });
      buf = await fsp.readFile(file);
    } catch (err) {
      if (errno(err) === 'ENOENT') return null;
      throw err;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      throw Object.assign(new Error('settings file is not valid UTF-8 text'), { code: 'ENOTUTF8' });
    }
  },
  async statMode(file) {
    try { return (await fsp.stat(file)).mode & 0o777; } catch (err) { if (errno(err) === 'ENOENT') return null; throw err; }
  },
  async isDirectory(dir) {
    try { return (await fsp.stat(dir)).isDirectory(); } catch { return false; }
  },
  async realpath(file) {
    try { return await fsp.realpath(file); } catch { return file; }
  },
  async isSymlink(file) {
    try { return (await fsp.lstat(file)).isSymbolicLink(); } catch { return false; }
  },
  async mkdirp(dir, mode) {
    await fsp.mkdir(dir, mode === undefined ? { recursive: true } : { recursive: true, mode });
    // mkdir applies the umask and leaves an existing directory alone; a private directory must be private either way.
    if (mode !== undefined) await fsp.chmod(dir, mode);
  },
  async copyFile(from, to) {
    // Not fsp.copyFile: that carries over the source's mode, and settings.json is often 0644 and may hold secrets.
    const data = await fsp.readFile(from);
    const handle = await fsp.open(to, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.chmod(to, 0o600);
  },
  async exists(file) {
    try { await fsp.access(file); return true; } catch { return false; }
  },
  async writeAtomic(file, text, mode) {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.mini-summa-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
    try {
      const handle = await fsp.open(tmp, 'wx', mode);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.chmod(tmp, mode);
      // Windows refuses to replace a file another program has open; a few quick retries cover a brief read by Claude Code.
      for (let attempt = 0; ; attempt++) {
        try { await fsp.rename(tmp, file); break; } catch (err) {
          const code = errno(err);
          if (attempt < 4 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) { await new Promise((r) => setTimeout(r, 60)); continue; }
          throw err;
        }
      }
    } catch (err) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Small pure helpers

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a); const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Windows paths (drive letter or UNC) are handled the Windows way even when this process is not on Windows. */
const pathModule = (p: string): typeof path.posix => (/^[A-Za-z]:[\\/]|^\\\\/.test(p) ? path.win32 : path.posix);
export function joinHost(dir: string, name: string): string {
  return pathModule(dir).join(dir, name);
}
const dirnameHost = (p: string): string => pathModule(p).dirname(p);
/** Same place? Windows paths compare without regard to case or trailing separators. */
function samePath(a: string, b: string): boolean {
  const m = pathModule(a);
  const norm = (x: string) => m.normalize(x).replace(/[\\/]+$/, '');
  return m === path.win32 ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}
function isInside(root: string, p: string): boolean {
  const m = pathModule(root);
  const rel = m.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${m.sep}`) && !m.isAbsolute(rel));
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const envTag = (env: EnvId): string => env.replace(/[^A-Za-z0-9_-]+/g, '-');
const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// ---------------------------------------------------------------------------------------------------------------
// Unified diff (LCS, 3 lines of context)

interface Line { text: string; noNl: boolean }
interface Op { kind: ' ' | '-' | '+'; line: Line }

function toLines(s: string): Line[] {
  if (s === '') return [];
  const parts = s.split('\n');
  const endsWithNewline = parts[parts.length - 1] === '';
  if (endsWithNewline) parts.pop();
  return parts.map((text, i) => ({ text, noNl: !endsWithNewline && i === parts.length - 1 }));
}
const same = (a: Line, b: Line): boolean => a.text === b.text && a.noNl === b.noNl;

function lcsOps(a: Line[], b: Line[]): Op[] {
  const n = a.length; const m = b.length;
  if (n === 0) return b.map((line) => ({ kind: '+', line }));
  if (m === 0) return a.map((line) => ({ kind: '-', line }));
  if (n * m > 4_000_000) return [...a.map((line): Op => ({ kind: '-', line })), ...b.map((line): Op => ({ kind: '+', line }))];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = same(a[i], b[j]) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) { ops.push({ kind: ' ', line: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ kind: '-', line: a[i] }); i++; }
    else { ops.push({ kind: '+', line: b[j] }); j++; }
  }
  for (; i < n; i++) ops.push({ kind: '-', line: a[i] });
  for (; j < m; j++) ops.push({ kind: '+', line: b[j] });
  return ops;
}

function diffOps(a: Line[], b: Line[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && same(a[start], b[start])) start++;
  let endA = a.length; let endB = b.length;
  while (endA > start && endB > start && same(a[endA - 1], b[endB - 1])) { endA--; endB--; }
  return [
    ...a.slice(0, start).map((line): Op => ({ kind: ' ', line })),
    ...lcsOps(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map((line): Op => ({ kind: ' ', line })),
  ];
}

/** Unified diff of two texts; '' when they are equal. A missing `before` (new file) is shown against /dev/null. */
export function unifiedDiff(before: string, after: string, file: string, opts: { context?: number; created?: boolean } = {}): string {
  const context = opts.context ?? 3;
  const ops = diffOps(toLines(before), toLines(after));
  const changed: number[] = [];
  ops.forEach((op, i) => { if (op.kind !== ' ') changed.push(i); });
  if (changed.length === 0) return '';

  // Line numbers (1-based) of the next line on each side at every op.
  const aAt: number[] = []; const bAt: number[] = [];
  let a = 1; let b = 1;
  for (const op of ops) { aAt.push(a); bAt.push(b); if (op.kind !== '+') a++; if (op.kind !== '-') b++; }

  const groups: [number, number][] = [];
  for (const idx of changed) {
    const last = groups[groups.length - 1];
    if (last && idx - last[1] <= 2 * context + 1) last[1] = idx; else groups.push([idx, idx]);
  }

  const range = (start: number, count: number): string => (count === 1 ? `${start}` : `${start},${count}`);
  const out: string[] = [`--- ${opts.created ? '/dev/null' : file}`, `+++ ${file}`];
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    let aCount = 0; let bCount = 0;
    const body: string[] = [];
    for (let i = from; i <= to; i++) {
      const op = ops[i];
      if (op.kind !== '+') aCount++;
      if (op.kind !== '-') bCount++;
      body.push(`${op.kind}${op.line.text}`);
      if (op.line.noNl) body.push('\\ No newline at end of file');
    }
    const aStart = aCount === 0 ? aAt[from] - 1 : aAt[from];
    const bStart = bCount === 0 ? bAt[from] - 1 : bAt[from];
    out.push(`@@ -${range(aStart, aCount)} +${range(bStart, bCount)} @@`, ...body);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// settings.json as text and as data

interface Loaded {
  exists: boolean;
  text: string;
  bom: boolean;
  eol: '\n' | '\r\n';
  indent: string;
  finalNewline: boolean;
  root: Obj;
}

function detectIndent(text: string): string {
  const m = /^([ \t]+)\S/m.exec(text);
  if (!m) return '  ';
  if (m[1].startsWith('\t')) return '\t';
  return ' '.repeat(m[1].length >= 1 && m[1].length <= 8 ? m[1].length : 2);
}

function parseSettings(text: string, file: string): Loaded {
  const bom = text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const base = { exists: true, text, bom, eol, indent: detectIndent(body), finalNewline: body === '' || /\n$/.test(body) } as const;
  if (body.trim() === '') return { ...base, root: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch (err) {
    // The parser's own message can quote the file; keep only where it stopped.
    const where = /line (\d+) column (\d+)/.exec((err as Error).message);
    throw unprocessable(
      `${file} is not valid JSON${where ? ` (it stops making sense near line ${where[1]}, column ${where[2]})` : ''}. Mini-Summa will not change a file it cannot read. Open it, fix or remove the broken part, then try again.`,
      'settings_not_json', { settingsPath: file });
  }
  if (!isObj(parsed)) {
    throw unprocessable(`${file} does not hold a JSON object, so Mini-Summa does not know how to add hooks to it. Replace its content with {} or fix it, then try again.`, 'settings_unexpected_shape', { settingsPath: file });
  }
  return { ...base, root: parsed };
}

function serialize(root: Obj, like: Pick<Loaded, 'bom' | 'eol' | 'indent' | 'finalNewline'>): string {
  let out = JSON.stringify(root, null, like.indent);
  if (like.eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  if (like.finalNewline) out += like.eol;
  return (like.bom ? '\uFEFF' : '') + out;
}

// ---------------------------------------------------------------------------------------------------------------
// Finding and changing our entries

type HookDef = Obj;
const shapeError = (file: string, what: string): CoreError =>
  unprocessable(`${file} has ${what}, which Claude Code cannot use and Mini-Summa will not rewrite. Fix that part of the file, then try again.`, 'settings_unexpected_shape', { settingsPath: file });

function makeIsOurs(layout: EnvLayout): (hook: unknown) => boolean {
  const script = baseName(layout.captureScriptInEnv);
  return (hook) => isObj(hook) && hook.type === 'command' && typeof hook.command === 'string' && hook.command.includes(script) && HANDLER_RE.test(hook.command);
}

interface Position { group: number; hook: number }

function ownedIn(groups: unknown[], isOurs: (h: unknown) => boolean): Position[] {
  const found: Position[] = [];
  groups.forEach((g, group) => {
    if (isObj(g) && Array.isArray(g.hooks)) g.hooks.forEach((hk, hook) => { if (isOurs(hk)) found.push({ group, hook }); });
  });
  return found;
}

interface Analysis { present: string[]; missing: string[]; duplicates: string[]; stale: string[]; shapeProblem: string | null }

function analyze(root: Obj, isOurs: (h: unknown) => boolean, desired: Record<string, HookDef> | null): Analysis {
  const present: string[] = []; const duplicates: string[] = []; const stale: string[] = [];
  let shapeProblem: string | null = null;
  const hooks = root.hooks;
  if (hooks !== undefined && !isObj(hooks)) shapeProblem = 'a "hooks" entry that is not an object';
  if (isObj(hooks)) {
    for (const event of EVENT_LIST) {
      const groups = hooks[event];
      if (groups === undefined) continue;
      if (!Array.isArray(groups)) { shapeProblem ??= `a "${event}" hook entry that is not a list`; continue; }
      const owned = ownedIn(groups, isOurs);
      if (owned.length === 0) continue;
      present.push(event);
      if (owned.length > 1) duplicates.push(event);
      if (desired && (owned.length > 1 || !deepEqual((groups[owned[0].group] as Obj & { hooks: unknown[] }).hooks[owned[0].hook], desired[event]))) stale.push(event);
    }
  }
  return { present, missing: EVENT_LIST.filter((e) => !present.includes(e)), duplicates, stale, shapeProblem };
}

/** One entry of ours per event. Adds missing ones, replaces a stale one where it stands and drops extra copies. */
function withInstalled(root: Obj, desired: Record<string, HookDef>, isOurs: (h: unknown) => boolean, file: string): Obj {
  const next = structuredClone(root);
  if (next.hooks === undefined) next.hooks = {};
  const hooks = next.hooks;
  if (!isObj(hooks)) throw shapeError(file, 'a "hooks" entry that is not an object');
  for (const event of EVENT_LIST) {
    const groups = hooks[event];
    if (groups === undefined) { hooks[event] = [{ hooks: [structuredClone(desired[event])] }]; continue; }
    if (!Array.isArray(groups)) throw shapeError(file, `a "${event}" hook entry that is not a list`);
    const owned = ownedIn(groups, isOurs);
    if (owned.length === 0) { groups.push({ hooks: [structuredClone(desired[event])] }); continue; }
    const [first, ...extra] = owned;
    const firstGroup = groups[first.group] as Obj & { hooks: unknown[] };
    if (extra.length === 0 && deepEqual(firstGroup.hooks[first.hook], desired[event])) continue;
    firstGroup.hooks[first.hook] = structuredClone(desired[event]);
    for (const pos of extra.reverse()) {
      const g = groups[pos.group] as Obj & { hooks: unknown[] };
      g.hooks.splice(pos.hook, 1);
      if (g.hooks.length === 0) groups.splice(pos.group, 1);
    }
  }
  return next;
}

/** Removes only our hooks, from any event, then whatever became empty because of that. */
function withoutOurs(root: Obj, isOurs: (h: unknown) => boolean): Obj {
  const next = structuredClone(root);
  const hooks = next.hooks;
  if (!isObj(hooks)) return next;
  let removedAny = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const owned = ownedIn(groups, isOurs);
    if (owned.length === 0) continue;
    removedAny = true;
    for (const pos of owned.reverse()) {
      const g = groups[pos.group] as Obj & { hooks: unknown[] };
      g.hooks.splice(pos.hook, 1);
      if (g.hooks.length === 0) groups.splice(pos.group, 1);
    }
    if (groups.length === 0) delete hooks[event];
  }
  if (removedAny && Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// The service

/** Where the bytes really go: the file behind any symbolic link, and which kind of link (if any) leads there. */
interface Resolved { target: string; fileIsLink: boolean; dirIsLink: boolean; configReal: string }

/** What a plan was computed for. `target` is the real file `apply` must write; the public HookPlan only names the path shown. */
interface Planned { plan: HookPlan; target: string; existed: boolean; configDir: string }

export interface HooksDeps {
  base: CoreBase;
  environments: EnvironmentsService;
  fs?: HooksFs;
}

interface Inspection {
  env: EnvId;
  layout: EnvLayout | null;
  settingsPath: string;
  configDir: string;
  loaded: Loaded | null;
  /** Why the file cannot be used, when it cannot. */
  problem: CoreError | null;
  isOurs: (h: unknown) => boolean;
  desired: Record<string, HookDef> | null;
  desiredProblem: CoreError | null;
  status: HookStatus;
}

export function createHooksService(deps: HooksDeps): HooksService {
  const { base, environments } = deps;
  const fs = deps.fs ?? nodeHooksFs;
  const log = base.log;

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  /** Backup paths promised by `plan`, so `apply` writes where the person was told. */
  const promised = new Map<string, string>();
  const promise = (hash: string, file: string): void => {
    promised.set(hash, file);
    if (promised.size > 32) promised.delete(promised.keys().next().value as string);
  };

  function buildDesired(env: EnvId, layout: EnvLayout): Record<string, HookDef> {
    if (!layout.runtime) {
      throw unprocessable(`No Node.js runtime was found in ${envLabel(env)}, so the capture hook could not run there. Install Node.js in that environment and try again. Sessions that Mini-Summa starts in its own terminals do not need this install.`, 'no_hook_runtime');
    }
    let built: ReturnType<typeof buildSettings>;
    try {
      built = buildSettings({
        env, node: layout.runtime.command, capture: layout.captureScriptInEnv, spool: layout.spoolDirInEnv,
        registry: layout.registryFileInEnv, handlers: [HOOK_HANDLER_ID], runAsNode: layout.runtime.runAsNode,
      });
    } catch (err) {
      throw unprocessable(`A path the hook needs cannot be used inside a shell command: ${(err as Error).message}. Move the Mini-Summa data folder to a path without quotes, dollar signs or backticks, then try again.`, 'unsafe_hook_path');
    }
    const out: Record<string, HookDef> = {};
    for (const event of EVENT_LIST) out[event] = built.hooks[event as keyof typeof built.hooks][0].hooks[0] as unknown as HookDef;
    return out;
  }

  function blankStatus(env: EnvId, layout: EnvLayout | null, settingsPath: string, configDir: string, issues: string[]): HookStatus {
    const rt = layout?.runtime ?? null;
    return {
      env, configDir, settingsPath, settingsExists: false, installed: false, events: [], missingEvents: [...EVENT_LIST],
      duplicateRegistrations: false,
      runtime: { command: rt?.command ?? '', kind: rt === null ? 'missing' : rt.runAsNode ? 'electron' : 'node', version: rt?.version ?? null },
      captureScript: layout?.captureScriptInEnv ?? '', issues,
    };
  }

  async function inspect(env: EnvId): Promise<Inspection> {
    let layout: EnvLayout;
    try { layout = await environments.layout(env); } catch (err) {
      const problem = unprocessable(`Mini-Summa could not look at ${envLabel(env)}: ${(err as Error).message}`, 'environment_unavailable');
      return { env, layout: null, settingsPath: '', configDir: '', loaded: null, problem, isOurs: () => false, desired: null, desiredProblem: problem, status: blankStatus(env, null, '', '', [problem.message]) };
    }
    const isOurs = makeIsOurs(layout);
    let desired: Record<string, HookDef> | null = null;
    let desiredProblem: CoreError | null = null;
    try { desired = buildDesired(env, layout); } catch (err) { desiredProblem = err instanceof CoreError ? err : null; if (!desiredProblem) throw err; }

    const configDir = layout.configDirHost ?? '';
    const settingsPath = configDir ? joinHost(configDir, 'settings.json') : '';
    const issues: string[] = [];
    if (desiredProblem) issues.push(desiredProblem.message);

    if (!configDir) {
      const problem = unprocessable(`Mini-Summa could not find the Claude configuration folder for ${envLabel(env)}, so it cannot read or change its settings.json. Start Claude Code there once, then refresh the environments.`, 'config_dir_unknown');
      issues.unshift(problem.message);
      return { env, layout, settingsPath, configDir, loaded: null, problem, isOurs, desired, desiredProblem, status: blankStatus(env, layout, settingsPath, configDir, issues) };
    }

    let loaded: Loaded | null = null;
    let problem: CoreError | null = null;
    try {
      const text = await fs.readText(settingsPath);
      if (text === null && await fs.isSymlink(settingsPath)) {
        throw unprocessable(`${settingsPath} is a link to a file that does not exist. Mini-Summa will not replace the link. Create the file it points to, or remove the link, then try again.`, 'settings_dangling_link', { settingsPath });
      }
      loaded = text === null ? { exists: false, text: '', bom: false, eol: '\n', indent: '  ', finalNewline: true, root: {} } : parseSettings(text, settingsPath);
    } catch (err) {
      problem = err instanceof CoreError ? err
        : unprocessable(`${settingsPath} could not be read (${errno(err) ?? 'unknown error'}). Check that the folder exists and that Mini-Summa may read it${isWslEnv(env) ? ', and that the WSL distribution is running' : ''}.`, 'settings_unreadable', { settingsPath });
      issues.unshift(problem.message);
    }

    const status = blankStatus(env, layout, settingsPath, configDir, issues);
    status.settingsExists = loaded?.exists ?? false;
    if (loaded) {
      const a = analyze(loaded.root, isOurs, desired);
      status.events = a.present;
      status.missingEvents = a.missing;
      status.duplicateRegistrations = a.duplicates.length > 0;
      status.installed = a.missing.length === 0 && a.shapeProblem === null;
      if (a.shapeProblem) issues.push(`${settingsPath} has ${a.shapeProblem}. Mini-Summa will not change it until that is fixed.`);
      if (a.present.length > 0 && a.missing.length > 0) issues.push(`Mini-Summa hooks are in place for ${a.present.length} of ${EVENT_LIST.length} events (missing: ${a.missing.join(', ')}). Install again to complete them.`);
      if (a.duplicates.length > 0) issues.push(`More than one Mini-Summa hook is registered for ${a.duplicates.join(', ')}. Every event would be captured twice. Install again to keep just one.`);
      if (a.stale.length > 0 && a.duplicates.length === 0 && a.missing.length < EVENT_LIST.length) issues.push(`The Mini-Summa hooks for ${a.stale.join(', ')} differ from what this version would write, for example another data folder. Install again to update them.`);
    }
    return { env, layout, settingsPath, configDir, loaded, problem, isOurs, desired, desiredProblem, status };
  }

  async function backupPathFor(env: EnvId): Promise<string> {
    const dir = path.join(base.dataDir, 'backups');
    const stem = `settings-${envTag(env)}-${stamp(base.clock.now())}`;
    let candidate = path.join(dir, `${stem}.json`);
    for (let n = 2; await fs.exists(candidate); n++) candidate = path.join(dir, `${stem}-${n}.json`);
    return candidate;
  }

  async function resolveTarget(ins: Inspection, exists: boolean): Promise<Resolved> {
    const configReal = await fs.realpath(ins.configDir);
    const fileIsLink = exists && await fs.isSymlink(ins.settingsPath);
    const target = exists ? await fs.realpath(ins.settingsPath) : joinHost(configReal, 'settings.json');
    return { target, fileIsLink, dirIsLink: !samePath(configReal, ins.configDir), configReal };
  }

  /** The closest directory at or above `start` that holds a `.git` entry (a folder, or a file for worktrees), or null. */
  async function findGitRoot(start: string): Promise<string | null> {
    let dir = start;
    for (let i = 0; i < 48; i++) {
      if (await fs.exists(joinHost(dir, '.git'))) return dir;
      const parent = dirnameHost(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  }

  async function planInternal(env: EnvId, action: 'install' | 'uninstall'): Promise<Planned> {
    const ins = await inspect(env);
    if (ins.problem || !ins.layout || !ins.loaded) throw ins.problem ?? unprocessable(`Mini-Summa could not look at ${envLabel(env)}.`, 'environment_unavailable');
    const { loaded, settingsPath } = ins;
    const warnings: string[] = [];

    let next: Obj;
    if (action === 'install') {
      if (ins.desiredProblem || !ins.desired) throw ins.desiredProblem ?? unprocessable('The hook could not be built.', 'no_hook_runtime');
      next = withInstalled(loaded.root, ins.desired, ins.isOurs, settingsPath);
    } else {
      next = withoutOurs(loaded.root, ins.isOurs);
    }
    const noop = deepEqual(loaded.root, next);
    const before = loaded.text;
    const after = noop ? before : serialize(next, loaded);

    let target = settingsPath;
    let linked = false;
    if (!noop) {
      // Where the change really lands matters more than anything else in the plan, so these warnings come first.
      const r = await resolveTarget(ins, loaded.exists);
      target = r.target;
      linked = r.fileIsLink || r.dirIsLink;
      if (r.fileIsLink) {
        warnings.push(`Check this first: ${settingsPath} is a symbolic link to ${r.target}. Mini-Summa writes through the link, so the file at ${r.target} is the one that changes, and the link stays as it is.`);
      } else if (r.dirIsLink) {
        warnings.push(`Check this first: the Claude configuration folder ${ins.configDir} is a link to ${r.configReal}. The file that changes is ${r.target}.`);
      }
      if (!isInside(r.configReal, r.target)) {
        warnings.push(`Check this first: the file that changes, ${r.target}, is outside your Claude configuration folder ${r.configReal}. Other programs or tools may share that file.`);
      }
      const gitRoot = await findGitRoot(dirnameHost(r.target));
      if (gitRoot) {
        warnings.push(`Check this first: ${r.target} is inside a git work tree (${gitRoot}). The change will show up there as an uncommitted edit, and the hook paths it adds belong to this computer, so do not commit them to a shared repository.`);
      }

      if (!loaded.exists) warnings.push('settings.json does not exist yet. It will be created, so no backup is needed.');
      if (!(await fs.isDirectory(ins.configDir))) warnings.push(`The Claude configuration folder ${ins.configDir} does not exist yet. Mini-Summa will create it.`);
      if (loaded.exists && serialize(loaded.root, loaded) !== loaded.text) {
        warnings.push('settings.json is not laid out the way Mini-Summa writes JSON, so saving it also re-indents lines that are not part of this change. The diff shows every changed line, and the backup keeps your original.');
      }
      const a = analyze(loaded.root, ins.isOurs, ins.desired);
      if (action === 'install') {
        if (a.duplicates.length) warnings.push(`More than one Mini-Summa hook is registered for ${a.duplicates.join(', ')}. Install keeps one of them.`);
        const replaced = a.stale.filter((e) => !a.duplicates.includes(e));
        if (replaced.length) warnings.push(`An existing Mini-Summa hook for ${replaced.join(', ')} points somewhere else. Install replaces it instead of adding a second one.`);
        warnings.push('Sessions that Mini-Summa starts in its own terminals always get these hooks through a private settings file, so they work without this install. This install adds capture for Claude Code sessions you start yourself in a normal terminal.');
      } else {
        warnings.push('Only Mini-Summa\'s own hook entries are removed. Your other settings and hooks are not touched. Sessions started in Mini-Summa terminals keep working.');
      }
    }
    if (isWslEnv(env)) {
      try {
        const info = (await environments.list()).find((e) => e.id === env);
        if (info && !info.available) warnings.push(`The WSL distribution ${env.slice(4)} does not look reachable right now. If writing fails, start it and try again.`);
      } catch { /* a missing listing is not worth a warning of its own */ }
    }

    const planAction: HookPlan['action'] = noop ? 'noop' : action;
    // For a plain file the hash is exactly sha256(env + action + settingsPath + before + after). When a link is involved
    // the resolved target is part of it too, so consent covers the file that will really change.
    const planHash = createHash('sha256').update(env + planAction + settingsPath + before + after + (linked ? `\0${target}` : '')).digest('hex');
    let backupPath = '';
    if (!noop && loaded.exists) {
      backupPath = promised.get(planHash) ?? await backupPathFor(env);
      promise(planHash, backupPath);
    }
    const plan: HookPlan = {
      env, settingsPath, planHash, action: planAction, before, after,
      unifiedDiff: unifiedDiff(before, after, settingsPath, { created: !loaded.exists }),
      backupPath, warnings, status: ins.status,
    };
    return { plan, target, existed: loaded.exists, configDir: ins.configDir };
  }

  function recordInstall(plan: HookPlan, backupPath: string | null): void {
    base.db.run(
      `INSERT INTO hook_installs (env, settings_path, handler_id, plan_hash, backup_path, installed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(env) DO UPDATE SET settings_path = excluded.settings_path, handler_id = excluded.handler_id,
         plan_hash = excluded.plan_hash, backup_path = excluded.backup_path, installed_at = excluded.installed_at`,
      [plan.env, plan.settingsPath, HOOK_HANDLER_ID, plan.planHash, backupPath, base.clock.now().toISOString()]);
  }

  const writeFailure = (settingsPath: string, err: unknown): CoreError => {
    if (err instanceof CoreError) return err;
    return unprocessable(`${settingsPath} could not be written (${errno(err) ?? 'unknown error'}). Nothing was changed. Close any program that has the file open, check the folder permissions, then try again.`, 'settings_unwritable', { settingsPath });
  };

  async function applyUnlocked(env: EnvId, action: 'install' | 'uninstall', planHash: string): Promise<HookStatus> {
    const { plan, target, existed, configDir } = await planInternal(env, action);
    if (plan.action === 'noop') return plan.status;
    if (plan.planHash !== planHash) {
      throw conflict('settings.json changed since this plan was shown, or the plan is no longer valid. Review the new plan and apply that one.', 'plan_stale');
    }
    const { settingsPath } = plan;
    const targetNow = async (): Promise<string> => (existed ? fs.realpath(settingsPath) : joinHost(await fs.realpath(configDir), 'settings.json'));
    // Stale means: the text differs from what the plan was computed from, or a link now leads somewhere else. The plan is
    // consent for one file only; the same target is used for the backup and the write below, never looked up again.
    const changedSince = async (): Promise<boolean> =>
      (await fs.readText(settingsPath).catch(() => null)) !== (existed ? plan.before : null) || (await targetNow()) !== target;
    const stale = () => conflict('settings.json, or the file a link leads to, changed while it was being updated. Nothing was written. Review the new plan and apply that one.', 'plan_stale');

    let backupPath: string | null = null;
    try {
      if (await changedSince()) throw stale();
      if (existed) {
        backupPath = plan.backupPath || await backupPathFor(env);
        if (await fs.exists(backupPath)) backupPath = await backupPathFor(env);
        await fs.mkdirp(path.dirname(backupPath), 0o700);
        await fs.copyFile(target, backupPath);
        if ((await fs.readText(backupPath)) !== plan.before) {
          throw unprocessable(`The backup ${backupPath} could not be verified, so settings.json was not changed. Check the free space and permissions of the Mini-Summa data folder.`, 'backup_failed');
        }
        if (await changedSince()) throw stale();
      } else {
        await fs.mkdirp(path.dirname(target));
      }
      const mode = existed ? ((await fs.statMode(target)) ?? 0o600) : 0o600;
      await fs.writeAtomic(target, plan.after, mode);
    } catch (err) {
      throw writeFailure(settingsPath, err);
    }

    if (action === 'install') recordInstall(plan, backupPath);
    else base.db.run('DELETE FROM hook_installs WHERE env = ?', [env]);
    const status = (await inspect(env)).status;
    base.bus.emit({ type: 'hooks.changed', env, status });
    log.info('hooks.applied', { env, action, settingsPath, target, backupPath });
    return status;
  }

  const status = async (env: EnvId): Promise<HookStatus> => {
    try { return (await inspect(env)).status; } catch (err) {
      log.error('hooks.status_failed', { env, message: (err as Error).message });
      return blankStatus(env, null, '', '', [`Mini-Summa could not check the hooks for ${envLabel(env)}: ${(err as Error).message}`]);
    }
  };

  return {
    async list() {
      const envs = await environments.list();
      return Promise.all(envs.map((e) => status(e.id)));
    },
    status,
    plan: (env, action) => serial(async () => (await planInternal(env, action)).plan),
    apply: (env, action, planHash) => serial(() => applyUnlocked(env, action, planHash)),
  };
}
