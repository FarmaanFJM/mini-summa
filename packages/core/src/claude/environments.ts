// EnvironmentsService: which environments Claude Code can run in, whether it (and Node.js for the hooks) is there, and
// where everything lives for each of them.
//
//  * The host environment is always listed. On a native Windows host every WSL distribution is listed too
//    (`wsl.exe -l -q`, UTF-16LE, docker-desktop* skipped).
//  * Claude is looked for in this order: Settings > Claude command, overrides.claudeBin, MINI_SUMMA_CLAUDE_BIN, PATH
//    (Windows: claude.exe, then claude.cmd), then the well-known install folders. A value that was configured but does not
//    exist is skipped with a note; a configured value that exists but does not start is reported, not silently replaced.
//    `available` means Claude was found AND `claude --version` answered, so "available" is never a guess.
//  * Hooks run the capture script with a Node runtime: the app's own Electron binary in ELECTRON_RUN_AS_NODE mode, or the
//    `node` on PATH, or `node` inside the WSL distribution. null = hooks cannot run in that environment.
//  * Results are cached; list({refresh:true}) probes again. Changing Settings > Claude command drops the host result.
//  * layout(host) never waits for the Claude version check (which can hang for its whole timeout): startup needs the
//    paths and the hook runtime, not the version.
//
// Contract notes (decisions where the brief and the sibling terminal host disagreed; both are one-line changes here):
//  - claudeCommand(WSL) is { file: 'claude', prefixArgs: [], wslDistro } : `file` is the command to run INSIDE the
//    distribution, because ptyHost.buildLaunchPlan builds `wsl.exe -d <distro> --cd <cwd> --exec <file> ...` itself.
//  - claudeCommand(Windows .cmd shim) is { file: '<shim>.cmd', prefixArgs: [] }, not `cmd.exe /d /c <shim>`:
//    buildLaunchPlan recognises a .cmd/.bat file and builds the safe `cmd.exe /d /s /c "..."` line itself. Only the
//    version check here goes through `cmd.exe /d /c <shim> --version`.
//
//  - On a Windows host the system programs this file starts (wsl.exe, cmd.exe) are started by FULL path
//    (windowsPrograms.ts), never by a bare name that the process-start code would look for in the current directory first.
//    PATH entries that are not absolute are ignored for the same reason.
//  - A .cmd/.bat shim is asked for its version as ONE verbatim command line, `cmd.exe /d /s /c ""<shim>" --version"`, the same
//    form ptyHost uses to launch it; a shim path with & | < > ^ % ! or a quote in it is refused (it is reported like a Claude
//    that does not start), because cmd.exe would read that character as syntax.
//
// Windows and WSL behaviour is exercised through an injected command runner and file-system probe only. NOT TESTED on
// a real Windows host or a real WSL2 distribution.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectEnv } from '@minisumma/claude-integration';
import { envLabel, isWslEnv, wslDistro } from '@minisumma/shared';
import type { EnvId, EnvironmentInfo } from '@minisumma/shared';
import type { CoreBase, CoreOptions, EnvLayout, EnvironmentsService, SettingsService } from '../contracts.ts';
import { CoreError } from '../errors.ts';
import { defaultCommandRunner, parseVersion, parseWslDistroList } from './commandRunner.ts';
import type { CommandResult, CommandRunner } from './commandRunner.ts';
import { envTag, windowsPathToWsl, wslPathToWindows } from './envPaths.ts';
import { cmdShimPathProblem, systemProgramPath } from './windowsPrograms.ts';

export const CLAUDE_INSTALL_URL = 'https://claude.com/product/claude-code';
const VERSION_TIMEOUT_MS = 10_000;
/** A WSL call may have to start the distribution first. */
const WSL_TIMEOUT_MS = 20_000;
const MAX_VERSION_ATTEMPTS = 3;

/** The machine the core runs on. Production uses the real process; tests inject a different one. */
export interface HostProbe {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homeDir: string;
  execPath: string;
  versions: { node?: string; electron?: string };
  /** A regular file that can be started (the executable bit is checked outside Windows). */
  fileExists(p: string): boolean;
}

export interface EnvironmentsDeps {
  base: CoreBase;
  settings: Pick<SettingsService, 'get' | 'onChange'>;
  overrides?: CoreOptions['overrides'];
  run?: CommandRunner;
  /** Test seam. */
  host?: Partial<HostProbe>;
}

export type ClaudeCommand = { file: string; prefixArgs: string[]; wslDistro: string | null };
type Runtime = NonNullable<EnvLayout['runtime']>;

interface Probe {
  info: EnvironmentInfo;
  layout: EnvLayout | null;
  layoutProblem: string | null;
  command: ClaudeCommand | null;
}

const fileExistsOn = (platform: NodeJS.Platform) => (p: string): boolean => {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const firstLine = (text: string): string => text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';

/** Ends a fragment with a full stop so it can be followed by the next sentence of a note. */
const sentence = (text: string): string => {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** Why a command did not work, as one sentence. */
function describeFailure(r: CommandResult): string {
  if (r.error) return sentence(r.error.split(/\r?\n/)[0].slice(0, 200));
  const line = firstLine(r.stderr) || firstLine(r.stdout);
  return line !== '' ? sentence(line.slice(0, 200)) : `It exited with code ${r.code}.`;
}

/**
 * Where the hook processes find the capture script: the built bundle (the package's "./hook" export), else the source script
 * ("./hook-source", development), else the same files by their place in the workspace for a package that does not declare
 * the exports. When nothing exists the bundle's path is returned, because that is where `npm run build:hook` writes it.
 */
export function resolveCaptureScript(io: { resolve(specifier: string): string; exists(file: string): boolean; packageRoot: string }): string {
  for (const spec of ['@minisumma/claude-integration/hook', '@minisumma/claude-integration/hook-source']) {
    try {
      const resolved = io.resolve(spec);
      if (io.exists(resolved)) return resolved;
    } catch { /* the export is not declared, or the file was not built */ }
  }
  for (const rel of ['dist/capture.mjs', 'src/hook/capture.mjs']) {
    const candidate = path.join(io.packageRoot, rel);
    if (io.exists(candidate)) return candidate;
  }
  return path.join(io.packageRoot, 'dist', 'capture.mjs');
}

let cachedCaptureScript: string | null = null;

function defaultCaptureScript(): string {
  if (cachedCaptureScript) return cachedCaptureScript;
  const require = createRequire(import.meta.url);
  cachedCaptureScript = resolveCaptureScript({
    resolve: (spec) => require.resolve(spec), exists: (f) => fs.existsSync(f),
    packageRoot: fileURLToPath(new URL('../../../claude-integration/', import.meta.url)),
  });
  return cachedCaptureScript;
}

export function createEnvironmentsService(deps: EnvironmentsDeps): EnvironmentsService & { dispose(): void } {
  const { base, settings } = deps;
  const overrides = deps.overrides ?? {};
  const run: CommandRunner = deps.run ?? defaultCommandRunner;

  const platform = deps.host?.platform ?? process.platform;
  const host: HostProbe = {
    platform,
    env: deps.host?.env ?? process.env,
    homeDir: overrides.homeDir ?? deps.host?.homeDir ?? os.homedir(),
    execPath: deps.host?.execPath ?? process.execPath,
    versions: deps.host?.versions ?? { node: process.versions.node, electron: process.versions.electron },
    fileExists: deps.host?.fileExists ?? fileExistsOn(platform),
  };
  const lib = host.platform === 'win32' ? path.win32 : path.posix;
  const hostEnvId: EnvId = overrides.hostEnv ?? detectEnv(host.platform, host.env);
  const hostIsWindows = hostEnvId === 'win';

  const safeRun = async (file: string, args: string[], timeoutMs: number, env?: Record<string, string>, verbatim?: boolean): Promise<CommandResult> => {
    try {
      return await run(file, args, verbatim ? { timeoutMs, env, windowsVerbatimArguments: true } : { timeoutMs, env });
    } catch (err) {
      return { stdout: '', stderr: '', code: null, error: err instanceof Error ? err.message : String(err) };
    }
  };

  /** A system program of a Windows host by full path (see windowsPrograms.ts); the plain name anywhere else. */
  const systemProgram = (name: 'wsl.exe' | 'cmd.exe'): string => (host.platform === 'win32' ? systemProgramPath(name, host.env) : name);

  // ---- Claude on the host ---------------------------------------------------------------------------------------------

  const pathDirs = (): string[] => {
    const raw = host.env.PATH ?? host.env.Path ?? '';
    // A relative entry (".", "bin") would be searched from the current directory, which is not where programs are installed.
    return raw.split(host.platform === 'win32' ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => d !== '' && lib.isAbsolute(d));
  };

  /** Executable names first, directories second: claude.exe anywhere on PATH beats claude.cmd. */
  const lookupOnPath = (names: string[]): string | null => {
    const dirs = pathDirs();
    for (const name of names) {
      for (const dir of dirs) {
        const candidate = lib.join(dir, name);
        if (host.fileExists(candidate)) return candidate;
      }
    }
    return null;
  };

  const claudeNames = host.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];

  function knownLocations(): string[] {
    const home = host.homeDir;
    const out: string[] = [];
    if (host.platform === 'win32') {
      out.push(lib.join(home, '.local', 'bin', 'claude.exe'), lib.join(home, '.claude', 'local', 'claude.exe'), lib.join(home, '.claude', 'local', 'claude.cmd'));
      const prefix = host.env.npm_config_prefix ?? host.env.NPM_CONFIG_PREFIX;
      if (prefix) out.push(lib.join(prefix, 'claude.cmd'));
      if (host.env.APPDATA) out.push(lib.join(host.env.APPDATA, 'npm', 'claude.cmd'));
    } else {
      out.push(lib.join(home, '.local', 'bin', 'claude'), lib.join(home, '.claude', 'local', 'claude'));
      const prefix = host.env.npm_config_prefix ?? host.env.NPM_CONFIG_PREFIX;
      if (prefix) out.push(lib.join(prefix, 'bin', 'claude'));
      out.push(lib.join(home, '.npm-global', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude');
    }
    return out;
  }

  /** A configured value is a path or a bare command name. Returns the file it names, or null when there is none. */
  function resolveConfigured(value: string): string | null {
    const isPath = /[\\/]/.test(value) || lib.isAbsolute(value);
    const variants = host.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(value) ? [`${value}.exe`, `${value}.cmd`, value] : [value];
    if (isPath) return variants.find((c) => host.fileExists(c)) ?? null;
    return lookupOnPath(variants);
  }

  /**
   * What callers start. A Windows .cmd shim is returned as the shim itself, NOT as `cmd.exe /d /c <shim>`: the terminal
   * host (ptyHost.buildLaunchPlan) recognises a .cmd/.bat file and builds the safe `cmd.exe /d /s /c "..."` line itself.
   * Passing `/d /c <shim> args...` through an argument array breaks as soon as two arguments need quotes.
   */
  const commandFor = (file: string): ClaudeCommand => ({ file, prefixArgs: [], wslDistro: null });

  /**
   * The command line that asks `file` for its version. Only here is a shim started through cmd.exe: as the same single
   * verbatim line ptyHost builds for a launch (`/d /s /c "<line>"`, cmd strips the outer quotes), with the path always quoted.
   */
  function versionCommand(file: string): { file: string; args: string[]; verbatim?: boolean } | { problem: string } {
    if (host.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
      const problem = cmdShimPathProblem(file);
      if (problem) return { problem };
      return { file: systemProgram('cmd.exe'), args: ['/d', '/s', '/c', `""${file}" --version"`], verbatim: true };
    }
    return { file, args: ['--version'] };
  }

  interface HostClaude { path: string | null; version: string | null; error: string | null; command: ClaudeCommand | null; notes: string[] }

  async function detectHostClaude(): Promise<HostClaude> {
    const notes: string[] = [];
    const configured = settings.get().sessions.claudeCommand?.trim() || null;
    const explicit: { what: string; value: string }[] = [];
    if (configured) explicit.push({ what: 'The Claude command set in Settings', value: configured });
    if (overrides.claudeBin) explicit.push({ what: 'The configured Claude executable', value: overrides.claudeBin });
    if (host.env.MINI_SUMMA_CLAUDE_BIN) explicit.push({ what: 'MINI_SUMMA_CLAUDE_BIN', value: host.env.MINI_SUMMA_CLAUDE_BIN });

    const seen = new Set<string>();
    let attempts = 0;
    let firstFailure: { path: string; error: string } | null = null;

    const tryFile = async (file: string): Promise<{ version: string } | { error: string }> => {
      const cmd = versionCommand(file);
      if ('problem' in cmd) return { error: cmd.problem };
      const r = await safeRun(cmd.file, cmd.args, VERSION_TIMEOUT_MS, undefined, cmd.verbatim);
      if (r.code === 0) {
        const version = parseVersion(r.stdout) ?? parseVersion(r.stderr);
        return version ? { version } : { error: 'It did not print a version.' };
      }
      return { error: describeFailure(r) };
    };

    for (const c of explicit) {
      const file = resolveConfigured(c.value);
      if (!file) {
        notes.push(`${c.what} (${c.value}) was not found, so Mini-Summa looked in the usual places instead.`);
        continue;
      }
      seen.add(file);
      const r = await tryFile(file);
      if ('version' in r) return { path: file, version: r.version, error: null, command: commandFor(file), notes };
      notes.push(`${c.what} (${file}) did not start: ${r.error} Check it in a terminal, or clear the setting to use the default.`);
      return { path: file, version: null, error: r.error, command: null, notes };
    }

    const auto: string[] = [];
    const onPath = lookupOnPath(claudeNames);
    if (onPath) auto.push(onPath);
    auto.push(...knownLocations().filter((p) => host.fileExists(p)));
    for (const file of auto) {
      if (seen.has(file)) continue;
      seen.add(file);
      const r = await tryFile(file);
      if ('version' in r) return { path: file, version: r.version, error: null, command: commandFor(file), notes };
      firstFailure ??= { path: file, error: r.error };
      if (++attempts >= MAX_VERSION_ATTEMPTS) break;
    }

    if (firstFailure) {
      notes.push(`Claude Code was found at ${firstFailure.path} but did not start: ${firstFailure.error} Run it in a terminal to see why, then press Refresh.`);
      return { path: firstFailure.path, version: null, error: firstFailure.error, command: null, notes };
    }
    notes.push(`Claude Code was not found. Install it from ${CLAUDE_INSTALL_URL}, then press Refresh.`);
    return { path: null, version: null, error: 'Claude Code was not found.', command: null, notes };
  }

  // ---- Node.js for the hooks ------------------------------------------------------------------------------------------

  async function nodeVersionOf(command: string, runAsNode: boolean): Promise<string | null> {
    const r = await safeRun(command, ['--version'], VERSION_TIMEOUT_MS, runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : undefined);
    return r.code === 0 ? parseVersion(r.stdout) : null;
  }

  async function detectHostNode(notes: string[]): Promise<Runtime | null> {
    if (overrides.nodeRuntime) {
      const { command, runAsNode } = overrides.nodeRuntime;
      return { command, runAsNode, version: await nodeVersionOf(command, runAsNode) };
    }
    if (host.versions.electron) return { command: host.execPath, runAsNode: true, version: host.versions.node ?? null };
    const found = lookupOnPath(host.platform === 'win32' ? ['node.exe'] : ['node']);
    if (found) {
      const version = await nodeVersionOf(found, false);
      if (version) return { command: found, runAsNode: false, version };
      notes.push(`Node.js was found at ${found} but did not start, so hooks cannot run here. Reinstall Node.js from https://nodejs.org, then press Refresh.`);
      return null;
    }
    notes.push('Node.js was not found, so hooks cannot run here. Install Node.js from https://nodejs.org, then press Refresh.');
    return null;
  }

  // ---- Layout ---------------------------------------------------------------------------------------------------------

  const spoolDirHostFor = (env: EnvId): string => lib.join(base.dataDir, 'spool', envTag(env));
  const registryFileHost = (): string => lib.join(base.dataDir, 'registry.json');
  const captureScriptHost = (): string => overrides.captureScript ?? defaultCaptureScript();

  // ---- The host environment -------------------------------------------------------------------------------------------

  // Three separately cached parts, so the quick one (where things live, and whether hooks can run) is never held up by the
  // slow one (asking Claude for its version, which can hang for the full timeout): the layout is what startup needs.
  let hostClaude: Promise<HostClaude> | null = null;
  let hostNode: Promise<{ runtime: Runtime | null; notes: string[] }> | null = null;
  let hostLayout: Promise<EnvLayout> | null = null;
  let hostProbe: Promise<Probe> | null = null;

  const getHostClaude = (): Promise<HostClaude> => (hostClaude ??= detectHostClaude());
  const getHostNode = (): Promise<{ runtime: Runtime | null; notes: string[] }> => (hostNode ??= (async () => {
    const notes: string[] = [];
    return { runtime: await detectHostNode(notes), notes };
  })());
  const getHostLayout = (): Promise<EnvLayout> => (hostLayout ??= (async () => {
    const { runtime } = await getHostNode();
    const configDir = host.env.CLAUDE_CONFIG_DIR || lib.join(host.homeDir, '.claude');
    const spool = spoolDirHostFor(hostEnvId);
    const registry = registryFileHost();
    return {
      env: hostEnvId, spoolDirHost: spool, registryFileHost: registry, spoolDirInEnv: spool, registryFileInEnv: registry,
      captureScriptInEnv: captureScriptHost(), runtime, configDirHost: configDir, configDirInEnv: configDir,
    };
  })());
  const getHost = (): Promise<Probe> => (hostProbe ??= (async () => {
    const [claude, node, layout] = await Promise.all([getHostClaude(), getHostNode(), getHostLayout()]);
    return {
      info: {
        id: hostEnvId, label: envLabel(hostEnvId), available: claude.version !== null,
        claude: { path: claude.path, version: claude.version, error: claude.error },
        node: { path: node.runtime?.command ?? null, version: node.runtime?.version ?? null },
        configDir: layout.configDirHost, hooks: null, notes: [...claude.notes, ...node.notes],
      },
      layout, layoutProblem: null, command: claude.command,
    };
  })());

  // ---- WSL distributions ----------------------------------------------------------------------------------------------

  interface Distros { names: string[]; notes: string[] }

  async function listDistros(): Promise<Distros> {
    const r = await safeRun(systemProgram('wsl.exe'), ['-l', '-q'], VERSION_TIMEOUT_MS);
    if (r.code !== 0) {
      base.log.debug('wsl.exe could not list distributions', { error: r.error ?? describeFailure(r) });
      return { names: [], notes: [] };
    }
    const names: string[] = [];
    const notes: string[] = [];
    for (const name of parseWslDistroList(r.stdout)) {
      if (/^[A-Za-z0-9._-]+$/.test(name)) names.push(name);
      else notes.push(`The WSL distribution "${name}" has characters Mini-Summa cannot use in a name (only letters, digits, dots, dashes and underscores). It is not listed.`);
    }
    return { names, notes };
  }

  async function probeWsl(distro: string): Promise<Probe> {
    const env = `wsl:${distro}` as EnvId;
    const wsl = (args: string[]) => safeRun(systemProgram('wsl.exe'), ['-d', distro, '--exec', ...args], WSL_TIMEOUT_MS);
    const [ver, where, nodeVer, home] = await Promise.all([
      wsl(['claude', '--version']),
      wsl(['sh', '-c', 'command -v claude']),
      wsl(['node', '--version']),
      wsl(['sh', '-c', 'printf %s "$HOME"']),
    ]);
    const notes: string[] = [];

    const claudePath = where.code === 0 && firstLine(where.stdout).startsWith('/') ? firstLine(where.stdout) : null;
    const claudeVersion = ver.code === 0 ? parseVersion(ver.stdout) ?? parseVersion(ver.stderr) : null;
    let claudeError: string | null = null;
    if (!claudeVersion) {
      if (ver.code === null && where.code === null) {
        claudeError = describeFailure(ver);
        notes.push(`Mini-Summa could not start ${distro}: ${claudeError} Open it once from the Start menu, then press Refresh.`);
      } else if (claudePath) {
        claudeError = describeFailure(ver);
        notes.push(`Claude Code was found at ${claudePath} inside ${distro} but did not start: ${claudeError} Run claude there to see why, then press Refresh.`);
      } else {
        claudeError = 'Claude Code was not found.';
        const login = await wsl(['sh', '-lc', 'command -v claude']);
        const loginPath = login.code === 0 && firstLine(login.stdout).startsWith('/') ? firstLine(login.stdout) : null;
        notes.push(loginPath
          ? `Claude Code is installed at ${loginPath} inside ${distro}, but it is not on the PATH Mini-Summa starts it with. Make it available in /usr/local/bin (sudo ln -s ${loginPath} /usr/local/bin/claude), then press Refresh.`
          : `Claude Code was not found inside ${distro}. Install it there from ${CLAUDE_INSTALL_URL}, then press Refresh.`);
      }
    }

    const nodeVersion = nodeVer.code === 0 ? parseVersion(nodeVer.stdout) : null;
    const runtime: Runtime | null = nodeVersion ? { command: 'node', runAsNode: false, version: nodeVersion } : null;
    if (!runtime && !(ver.code === null && where.code === null)) {
      notes.push(`Node.js was not found inside ${distro}, so hooks cannot run there. Install Node.js in that distribution.`);
    }

    const homePath = home.code === 0 && home.stdout.trim().startsWith('/') ? home.stdout.trim() : null;
    const configDirInEnv = homePath ? `${homePath.replace(/\/+$/, '')}/.claude` : null;
    const configDirHost = configDirInEnv ? wslPathToWindows(distro, configDirInEnv) : null;

    // Where the hook process inside the distribution finds Mini-Summa's folders.
    const toWsl = async (hostPath: string): Promise<string | null> => {
      const r = await wsl(['wslpath', '-u', hostPath]);
      const out = r.code === 0 ? firstLine(r.stdout) : '';
      return out.startsWith('/') ? out : windowsPathToWsl(hostPath, { distro });
    };
    const spoolHost = spoolDirHostFor(env);
    const registryHost = registryFileHost();
    const captureHost = captureScriptHost();
    const [spoolIn, registryIn, captureIn] = await Promise.all([toWsl(spoolHost), toWsl(registryHost), toWsl(captureHost)]);

    let layout: EnvLayout | null = null;
    let layoutProblem: string | null = null;
    if (spoolIn && registryIn && captureIn) {
      layout = {
        env, spoolDirHost: spoolHost, registryFileHost: registryHost, spoolDirInEnv: spoolIn, registryFileInEnv: registryIn,
        captureScriptInEnv: captureIn, runtime, configDirHost, configDirInEnv,
      };
    } else {
      layoutProblem = `Claude inside ${envLabel(env)} cannot reach Mini-Summa's data folder (${base.dataDir}). Put the data folder on a Windows drive.`;
      notes.push(layoutProblem);
    }

    return {
      info: {
        id: env, label: envLabel(env), available: claudeVersion !== null,
        claude: { path: claudePath, version: claudeVersion, error: claudeError },
        node: { path: runtime ? 'node' : null, version: nodeVersion },
        configDir: configDirHost, hooks: null, notes,
      },
      layout, layoutProblem,
      // `file` is the command to run INSIDE the distribution (the same `claude` that was just asked for its version);
      // the terminal host builds `wsl.exe -d <distro> --cd <cwd> --exec claude ...` around it.
      command: claudeVersion !== null ? { file: 'claude', prefixArgs: [], wslDistro: distro } : null,
    };
  }

  // ---- Caches ---------------------------------------------------------------------------------------------------------

  let distros: Promise<Distros> | null = null;
  const wslProbes = new Map<string, Promise<Probe>>();

  const getDistros = (): Promise<Distros> => (distros ??= listDistros());
  const getWsl = (name: string): Promise<Probe> => {
    let p = wslProbes.get(name);
    if (!p) { p = probeWsl(name); wslProbes.set(name, p); }
    return p;
  };

  function invalidate(): void {
    hostClaude = null;
    hostNode = null;
    hostLayout = null;
    hostProbe = null;
    distros = null;
    wslProbes.clear();
  }

  async function probeFor(env: EnvId): Promise<Probe> {
    if (env === hostEnvId) return getHost();
    if (hostIsWindows && isWslEnv(env)) {
      const want = wslDistro(env)!.toLowerCase();
      const listed = (await getDistros()).names.find((n) => n.toLowerCase() === want);
      if (listed) return getWsl(listed);
    }
    throw new CoreError(404, 'unknown_environment', `${envLabel(env)} is not available on this computer.`);
  }

  const offSettings = settings.onChange((next, prev) => {
    if (next.sessions.claudeCommand !== prev.sessions.claudeCommand) { hostClaude = null; hostProbe = null; }
  });

  return {
    hostEnv: () => hostEnvId,

    async list(opts) {
      if (opts?.refresh) invalidate();
      const hostResult = await getHost();
      const infos: EnvironmentInfo[] = [structuredClone(hostResult.info)];
      if (hostIsWindows) {
        const d = await getDistros();
        infos[0].notes.push(...d.notes);
        const probes = await Promise.all(d.names.map(getWsl));
        infos.push(...probes.map((p) => structuredClone(p.info)));
      }
      return infos;
    },

    async layout(env) {
      if (env === hostEnvId) return structuredClone(await getHostLayout()); // never waits for the Claude version check
      const probe = await probeFor(env);
      if (!probe.layout) throw new CoreError(422, 'env_layout', probe.layoutProblem ?? `Mini-Summa could not prepare ${envLabel(env)}.`);
      return structuredClone(probe.layout);
    },

    async claudeCommand(env) {
      try {
        const cmd = (await probeFor(env)).command;
        return cmd ? { ...cmd, prefixArgs: [...cmd.prefixArgs] } : null;
      } catch {
        return null;
      }
    },

    dispose: () => { offSettings(); },
  };
}
