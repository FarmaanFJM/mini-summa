#!/usr/bin/env tsx
// Headless runner: the Mini-Summa core without the desktop shell. Used for development, for the integration tests and
// for running the service on a machine without a display. The desktop app embeds the same core in-process.
import os from 'node:os';
import path from 'node:path';
import { createCore } from './core.ts';

interface Args {
  dataDir: string;
  port: number | undefined;
  uiDir: string | undefined;
  claudeBin: string | undefined;
  printConnection: boolean;
  help: boolean;
}

function defaultDataDir(): string {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Mini-Summa', 'data');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Mini-Summa', 'data');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'mini-summa');
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dataDir: defaultDataDir(), port: undefined, uiDir: undefined, claudeBin: undefined, printConnection: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--print-connection') a.printConnection = true;
    else if (k === '--data-dir') a.dataDir = path.resolve(argv[++i] ?? '');
    else if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--ui-dir') a.uiDir = path.resolve(argv[++i] ?? '');
    else if (k === '--claude-bin') a.claudeBin = argv[++i];
    else throw new Error(`Unknown argument: ${k}`);
  }
  if (a.port !== undefined && (!Number.isInteger(a.port) || a.port < 0 || a.port > 65535)) throw new Error('--port must be between 0 and 65535');
  return a;
}

const HELP = `minisumma-core: Mini-Summa without the desktop shell

  --data-dir <dir>       where the database, spools and settings live (default: your user data directory)
  --port <n>             127.0.0.1 port (default 47811, falls back to a free port if it is taken; 0 = any free port)
  --ui-dir <dir>         serve a built renderer under /ui/
  --claude-bin <path>    use this Claude Code executable instead of finding one on PATH
  --print-connection     print one JSON line {"baseUrl","desktopToken"} on stdout when ready
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }
  const core = await createCore({
    dataDir: args.dataDir,
    mode: 'headless',
    checkFolders: true,
    version: process.env.npm_package_version ?? '0.1.0',
    port: args.port,
    uiDir: args.uiDir,
    overrides: args.claudeBin ? { claudeBin: args.claudeBin } : undefined,
  });
  await core.start();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`Stopping on ${signal}\n`);
    try { await core.stop(); } finally { process.exit(0); }
  };
  // Registered before the "ready" line is printed, so whoever waits for that line can signal at once.
  // SIGTERM never arrives on Windows. There, Ctrl+C is SIGINT, Ctrl+Break is SIGBREAK, and closing the console window is SIGHUP
  // (Node ends the process a few seconds after it): all of them must stop the terminals Claude runs in, not leave them behind.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(signal, () => void stop(signal));

  if (args.printConnection) process.stdout.write(`${JSON.stringify({ baseUrl: core.baseUrl, desktopToken: core.desktopToken })}\n`);
  else process.stderr.write(`Mini-Summa core listening on ${core.baseUrl} (data: ${args.dataDir})\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
