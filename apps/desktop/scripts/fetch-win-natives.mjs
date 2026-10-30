#!/usr/bin/env node
// The Windows build of the pty (@lydell/node-pty-win32-x64) is an OPTIONAL dependency of @lydell/node-pty: npm installs
// it only on Windows. To build the Windows installer from Linux or macOS it is fetched here instead, as the exact version
// that matches the installed @lydell/node-pty, and unpacked to build/native/node_modules/@lydell/node-pty-win32-x64.
// electron-builder then adds that folder to the app as node_modules/@lydell/node-pty-win32-x64 (see electron-builder.yml).
//
// How it is found at run time: @lydell/node-pty/index.js does require(`@lydell/node-pty-${process.platform}-${process.arch}`),
// an ordinary node_modules lookup. The overlay puts the package where that lookup looks (inside app.asar/node_modules, with
// the whole package unpacked to app.asar.unpacked so the .node files, conpty.dll and OpenConsole.exe are real files).
//
// Supply chain: the tarball is checked against the sha512 that package-lock.json records for that exact version (or, when
// the lockfile has no entry, against the registry), and the download is refused on a mismatch.
//
//   node apps/desktop/scripts/fetch-win-natives.mjs [--force]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const require = createRequire(path.join(appRoot, 'package.json'));
const PACKAGE = '@lydell/node-pty-win32-x64';
const dest = path.join(appRoot, 'build', 'native', 'node_modules', '@lydell', 'node-pty-win32-x64');
const REQUIRED = [
  'package.json', 'lib/index.js', 'lib/windowsTerminal.js', 'lib/worker/conoutSocketWorker.js',
  'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node',
  'prebuilds/win32-x64/conpty/conpty.dll', 'prebuilds/win32-x64/conpty/OpenConsole.exe',
];

const log = (msg) => console.log(`[fetch-win-natives] ${msg}`);
const fail = (msg) => { console.error(`[fetch-win-natives] ${msg}`); process.exit(1); };

// The package restricts its "exports", so package.json is found next to the entry file instead of by subpath.
const ptyManifestPath = path.join(path.dirname(require.resolve('@lydell/node-pty')), 'package.json');
const ptyManifest = JSON.parse(fs.readFileSync(ptyManifestPath, 'utf8'));
const version = ptyManifest.version;
const wanted = ptyManifest.optionalDependencies?.[PACKAGE];
if (wanted !== version) fail(`@lydell/node-pty ${version} lists ${PACKAGE}@${wanted ?? 'nothing'}, expected the same version`);
const spec = `${PACKAGE}@${version}`;

const marker = path.join(dest, '.fetched-integrity');
function expectedIntegrity() {
  // The lockfile of the workspace root records the integrity of every optional platform package.
  let dir = appRoot;
  for (let i = 0; i < 4; i += 1, dir = path.dirname(dir)) {
    const lock = path.join(dir, 'package-lock.json');
    if (!fs.existsSync(lock)) continue;
    const entry = JSON.parse(fs.readFileSync(lock, 'utf8')).packages?.[`node_modules/${PACKAGE}`];
    if (entry?.version === version && entry.integrity) return { integrity: entry.integrity, source: `package-lock.json (${path.relative(process.cwd(), lock) || 'package-lock.json'})` };
  }
  const fromRegistry = execNpm(['view', spec, 'dist.integrity']).trim();
  if (!fromRegistry.startsWith('sha512-')) fail(`could not determine the expected integrity of ${spec}`);
  return { integrity: fromRegistry, source: 'the npm registry' };
}

function execNpm(args, opts = {}) {
  const win = process.platform === 'win32';
  return execFileSync(win ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', shell: win, stdio: ['ignore', 'pipe', 'inherit'], ...opts });
}

const { integrity, source } = expectedIntegrity();
if (!process.argv.includes('--force') && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === `${spec} ${integrity}`
  && REQUIRED.every((f) => fs.existsSync(path.join(dest, f)))) {
  log(`${spec} is already in place (integrity from ${source}).`);
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-win-natives-'));
try {
  log(`fetching ${spec} with npm pack (nothing is installed)`);
  // Run in a directory without a package.json so that the workspace and its lockfile are never touched.
  const packed = JSON.parse(execNpm(['pack', spec, '--pack-destination', work, '--json', '--ignore-scripts'], { cwd: work }));
  const tarball = path.join(work, packed[0].filename);
  const actual = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`;
  if (actual !== integrity) fail(`integrity mismatch for ${spec}\n  expected ${integrity} (${source})\n  computed ${actual}`);
  if (packed[0].integrity && packed[0].integrity !== actual) fail(`npm reported a different integrity than the file has for ${spec}`);
  log(`integrity verified against ${source}`);

  const staging = path.join(work, 'package');
  fs.mkdirSync(staging);
  execFileSync('tar', ['-xzf', tarball, '-C', staging, '--strip-components=1'], { stdio: 'inherit' });
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(staging, f)));
  if (missing.length) fail(`${spec} is missing expected files: ${missing.join(', ')}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
  if (manifest.name !== PACKAGE || manifest.version !== version) fail(`unexpected package contents: ${manifest.name}@${manifest.version}`);

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(staging, dest, { recursive: true });
  fs.writeFileSync(marker, `${spec} ${integrity}\n`);
  const sizes = REQUIRED.map((f) => `${f} (${fs.statSync(path.join(dest, f)).size} bytes)`);
  log(`unpacked to ${path.relative(process.cwd(), dest) || dest}\n  ${sizes.join('\n  ')}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
