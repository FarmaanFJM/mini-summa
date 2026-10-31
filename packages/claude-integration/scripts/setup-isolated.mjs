#!/usr/bin/env node
// Prepares an ISOLATED Claude configuration and throwaway repositories. It never writes to the normal
// Claude configuration directory and refuses to use it.
//
// usage: node scripts/setup-isolated.mjs [--base DIR] [--shared DIR] [--handlers 1|2] [--wsl-win-repo]
//   --base    environment-local root (config dir and work repos). Default: %LOCALAPPDATA%\MiniSummaPoc on Windows,
//             ~/.mini-summa-poc on Linux and WSL.
//   --shared  directory visible to Windows holding spool, registry, store, reports. Default on Windows: --base.
//             Inside WSL it defaults to the Windows %LOCALAPPDATA%\MiniSummaPoc reached through /mnt/<drive>/.
//   --handlers number of capture registrations (2 on purpose for qualification: every event arrives twice)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectEnv, canonicalize } from '../src/lib/registry.mjs';
import { buildSettings, layout, isNormalConfigDir } from '../src/lib/setup.mjs';

const a = {};
for (let i = 2; i < process.argv.length; i++) { const k = process.argv[i]; if (k.startsWith('--')) a[k.slice(2)] = process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[++i]; }
const env = detectEnv();
const here = path.dirname(fileURLToPath(import.meta.url));
const capture = path.resolve(here, '../src/hook/capture.mjs');

function windowsLocalAppDataFromWsl() {
  const win = execFileSync('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], { encoding: 'utf8' }).replace(/\r?\n/g, '').trim();
  return execFileSync('wslpath', ['-u', win], { encoding: 'utf8' }).trim();
}
const base = a.base ?? (env === 'win' ? path.win32.join(process.env.LOCALAPPDATA ?? os.homedir(), 'MiniSummaPoc') : path.posix.join(os.homedir(), '.mini-summa-poc'));
let shared = a.shared;
if (!shared) {
  if (env === 'win') shared = base;
  else if (env.startsWith('wsl:')) { try { shared = path.posix.join(windowsLocalAppDataFromWsl(), 'MiniSummaPoc'); } catch { console.error('Cannot find the Windows side from WSL (interop disabled?). Pass --shared /mnt/c/Users/<you>/AppData/Local/MiniSummaPoc'); process.exit(2); } }
  else shared = base;
}
const L = layout({ env, base, shared });

// Refuse the normal Claude configuration directory (or anything inside it) outright.
if (isNormalConfigDir(L.config, [os.homedir(), process.env.USERPROFILE])) { console.error('refusing to use the normal Claude config directory'); process.exit(2); }

const handlers = Number(a.handlers ?? 1) === 2 ? ['h1', 'h2'] : ['h1'];
const settings = buildSettings({ env, node: process.execPath, capture, spool: L.spool, registry: L.registry, handlers });
for (const d of [L.config, L.work, L.spool, L.store, L.reports]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(L.config, 'settings.json'), JSON.stringify(settings, null, 2));

// Throwaway repositories. projA lives where BOTH environments can reach it only when base is a Windows path;
// otherwise each environment gets its own projects.
const projects = [];
const names = env === 'win' ? ['projA', 'projB'] : env.startsWith('wsl:') ? ['projW'] : ['projA', 'projB'];
for (const name of names) {
  const dir = path.join(L.work, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\nThrowaway repository for the Mini-Summa qualification.\n`);
  }
  projects.push({ id: `proj-${name}`, name, roots: [{ env, path: dir }] });
}
// Merge into the shared registry so Windows and WSL projects live in one file.
let reg = { projects: [] };
if (fs.existsSync(L.registry)) reg = JSON.parse(fs.readFileSync(L.registry, 'utf8'));
for (const p of projects) {
  const ex = reg.projects.find((x) => x.id === p.id);
  if (!ex) reg.projects.push(p);
  else for (const r of p.roots) if (!ex.roots.some((y) => JSON.stringify(canonicalize(y.path, y.env)) === JSON.stringify(canonicalize(r.path, r.env)))) ex.roots.push(r);
}
fs.writeFileSync(L.registry, JSON.stringify(reg, null, 2));

console.log(JSON.stringify({ env, ...L, shared, handlers, projects: projects.map((p) => p.name),
  launch_hint: env === 'win'
    ? `$env:CLAUDE_CONFIG_DIR = "${L.config}"; Set-Location "${path.join(L.work, names[0])}"; claude --session-id <uuid>`
    : `CLAUDE_CONFIG_DIR="${L.config}" claude --session-id <uuid>   (run inside ${path.join(L.work, names[0])})` }, null, 2));
