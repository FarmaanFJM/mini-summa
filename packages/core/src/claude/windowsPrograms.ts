// The Windows programs Mini-Summa starts itself (wsl.exe, cmd.exe), always by full path.
//
// A bare program name is resolved by the process-start code (libuv, CreateProcess) in the current directory BEFORE the system
// directories, so a planted wsl.exe or cmd.exe in the folder the app happens to run in would be started instead of the real
// one. Everything here is a pure function of the environment variables it is given, so the Windows rules can be unit-tested
// on any machine. They have NOT been run on a real Windows host.
import path from 'node:path';

type Variables = Readonly<Record<string, string | undefined>>;

const FALLBACK_WINDOWS_DIRECTORY = 'C:\\Windows';
// A local drive path only: a bare or relative name resolves from the current directory, a share (\\server\x) runs remote code.
// eslint-disable-next-line no-control-regex
const LOCAL_DRIVE_PATH = /^[A-Za-z]:[\\/][^"<>|*?\u0000-\u001f]*$/;

/** Windows variable names are case-insensitive; the plain objects used in tests are not. */
function variable(env: Variables, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

/** %SystemRoot% (else %windir%) when it is a local drive path, otherwise C:\Windows. */
export function windowsDirectory(env: Variables): string {
  for (const name of ['SystemRoot', 'windir']) {
    const value = variable(env, name)?.trim();
    if (value && LOCAL_DRIVE_PATH.test(value)) {
      const normal = path.win32.normalize(value);
      return normal.length > 3 ? normal.replace(/[\\/]+$/, '') : normal;
    }
  }
  return FALLBACK_WINDOWS_DIRECTORY;
}

/**
 * Full path of a system program: <SystemRoot>\System32\<name>. For cmd.exe the command interpreter Windows itself names in
 * %ComSpec% is used when it is a local path to a cmd.exe; anything else in that variable is ignored.
 */
export function systemProgramPath(name: 'wsl.exe' | 'cmd.exe', env: Variables): string {
  if (name === 'cmd.exe') {
    const comspec = variable(env, 'ComSpec')?.trim();
    if (comspec && LOCAL_DRIVE_PATH.test(comspec) && path.win32.basename(comspec).toLowerCase() === 'cmd.exe') return path.win32.normalize(comspec);
  }
  return path.win32.join(windowsDirectory(env), 'System32', name);
}

// Inside a cmd.exe command line these end the quoting, chain a second command, redirect, expand a variable (%) or, with delayed
// expansion switched on, expand one (!). None of them can be escaped reliably, so a path that holds one is refused.
// eslint-disable-next-line no-control-regex
const CMD_UNSAFE_IN_PATH = /[&|<>^%!"\u0000-\u001f]/;

/** Why a .cmd/.bat path cannot be handed to `cmd.exe /d /s /c`, as a sentence; null when it can. */
export function cmdShimPathProblem(file: string): string | null {
  if (!CMD_UNSAFE_IN_PATH.test(file)) return null;
  return 'Its path contains a character that cmd.exe reads as part of a command (one of & | < > ^ % ! or a quote), so Mini-Summa will not start it through cmd.exe. Move it to a folder without such a character, or install the native claude.exe.';
}
