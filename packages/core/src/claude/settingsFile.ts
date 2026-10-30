// The per-session settings file that gives a managed Claude Code session its hooks: `claude --settings <file>`.
//
// Claude Code merges the file with the user's own settings for that one process, so nothing in the user's
// ~/.claude/settings.json is touched and no repository file is modified. The hooks are the verified PoC set (all nine
// events, the capture script, `--handler ms-managed`) built by `buildSettings` from the environment's layout.
import fs from 'node:fs';
import path from 'node:path';
import { buildSettings } from '@minisumma/claude-integration';
import type { HookSettings } from '@minisumma/claude-integration';
import { UUID_RE, envLabel, isWslEnv, wslDistro } from '@minisumma/shared';
import type { EnvId } from '@minisumma/shared';
import type { EnvLayout } from '../contracts.ts';
import { CoreError } from '../errors.ts';
import { envTag } from './envPaths.ts';
import { renameSyncWithRetry } from './fsRetry.ts';

/** Handler id of hooks registered through managed settings files; the user-level install uses its own id. */
export const MANAGED_HANDLER_ID = 'ms-managed';

export interface ManagedSettingsInput {
  layout: EnvLayout;
  sessionId: string;
  handlerId?: string;
  /** Root of Mini-Summa's runtime data on the host. */
  dataDir: string;
}

export interface ManagedSettingsPlan {
  /** Directory name for this environment: `win`, `posix`, `wsl-Ubuntu`. */
  tag: string;
  /** Where the file is written, as the core sees it. */
  hostPath: string;
  /** The same file as Claude Code inside the environment sees it (for WSL a /mnt/<drive>/... path). */
  envPath: string;
  settings: HookSettings;
}

export type ManagedSettingsFile = ManagedSettingsPlan & { handlerId: string };

export function managedSettingsTag(env: EnvId): string {
  return env.replace(/[^A-Za-z0-9._-]+/g, '-');
}

const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');

/**
 * Path of a host file as seen from inside `env`. Identity everywhere except WSL, where a Windows path becomes
 * /mnt/<drive>/... (the default automount root) and a \\wsl$\<same distro>\... path becomes the Linux path it names.
 */
export function hostPathToEnvPath(env: EnvId, hostPath: string): string {
  if (!isWslEnv(env)) return hostPath;
  const drive = /^([A-Za-z]):[\\/]*(.*)$/.exec(hostPath);
  if (drive) {
    const rest = drive[2].split(/[\\/]+/).filter(Boolean).join('/');
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  const unc = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]+([^\\/]+)((?:[\\/].*)?)$/i.exec(hostPath);
  if (unc) {
    if (unc[1].toLowerCase() !== (wslDistro(env) ?? '').toLowerCase()) {
      throw new CoreError(422, 'settings_path_unreachable', `The data folder is inside WSL distribution ${unc[1]}, which cannot be used by ${envLabel(env)}.`);
    }
    const rest = unc[2].split(/[\\/]+/).filter(Boolean).join('/');
    return `/${rest}`;
  }
  throw new CoreError(422, 'settings_path_unreachable', `Claude inside ${envLabel(env)} cannot reach Mini-Summa's data folder (${hostPath}). Put the data folder on a Windows drive.`);
}

/**
 * The settings file as Claude inside the environment sees it. For WSL, where the distribution mounts the Windows drives is not always
 * /mnt (wsl.conf [automount] root), and the layout already holds the data folder as the distribution sees it, converted by
 * `wslpath -u` (spoolDirInEnv = <data folder>/spool/<tag>): the file goes relative to that, like the spool, the registry and the
 * capture script do. The /mnt/<drive> rule of hostPathToEnvPath is the fallback.
 */
function settingsPathInEnv(layout: EnvLayout, hostPath: string, tag: string, sessionId: string): string {
  if (isWslEnv(layout.env)) {
    const suffix = `/spool/${envTag(layout.env)}`;
    if (layout.spoolDirInEnv.endsWith(suffix)) return `${layout.spoolDirInEnv.slice(0, -suffix.length)}/managed-settings/${tag}/${sessionId.toLowerCase()}.json`;
  }
  return hostPathToEnvPath(layout.env, hostPath);
}

/** Decides where the file goes and what it contains, without touching the disk. */
export function planManagedSettings(input: ManagedSettingsInput): ManagedSettingsPlan {
  const { layout, sessionId, dataDir } = input;
  if (!UUID_RE.test(sessionId)) throw new CoreError(400, 'bad_session_id', 'The session id is not a valid UUID.');
  if (!layout.runtime) {
    throw new CoreError(422, 'no_hook_runtime',
      `Mini-Summa needs Node.js to record what Claude Code does, and none was found in ${envLabel(layout.env)}. `
      + `Install Node.js 22 or newer there (https://nodejs.org), then start the session again. The session was not started.`);
  }
  let settings: HookSettings;
  try {
    settings = buildSettings({
      env: layout.env,
      node: layout.runtime.command,
      capture: layout.captureScriptInEnv,
      spool: layout.spoolDirInEnv,
      registry: layout.registryFileInEnv,
      handlers: [input.handlerId ?? MANAGED_HANDLER_ID],
      runAsNode: layout.runtime.runAsNode,
    });
  } catch (err) {
    throw new CoreError(422, 'unsafe_hook_path',
      `A folder name Mini-Summa needs for Claude's hooks contains a character that is not safe in a shell command (a double quote, $, a backtick or a line break). ${err instanceof Error ? err.message : String(err)}`);
  }
  const tag = managedSettingsTag(layout.env);
  const lib = isWindowsPath(dataDir) ? path.win32 : path.posix;
  const hostPath = lib.join(dataDir, 'managed-settings', tag, `${sessionId.toLowerCase()}.json`);
  return { tag, hostPath, envPath: settingsPathInEnv(layout, hostPath, tag, sessionId), settings };
}

/** Writes `<dataDir>/managed-settings/<tag>/<sessionId>.json` (mode 0600, replaced atomically). */
export function writeManagedSettings(input: ManagedSettingsInput): ManagedSettingsFile {
  const plan = planManagedSettings(input);
  const dir = path.dirname(plan.hostPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tmp, `${JSON.stringify(plan.settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    // A resumed session replaces the file of its earlier run, which a scanner or an editor may hold for a moment on Windows.
    renameSyncWithRetry(tmp, plan.hostPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to clean */ }
    throw err;
  }
  try { fs.chmodSync(plan.hostPath, 0o600); } catch { /* not supported on this file system (Windows) */ }
  return { ...plan, handlerId: input.handlerId ?? MANAGED_HANDLER_ID };
}
