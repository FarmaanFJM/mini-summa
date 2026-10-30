// electron-builder beforePack hook: refuse to package an incomplete or inconsistent build, and make sure the
// Windows-only native files are present when the target is Windows. (CommonJS because the package is "type": "module".)
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function beforePack(context) {
  const projectDir = context.packager.projectDir;
  const platform = context.electronPlatformName;
  const problems = [];

  const need = (rel, how) => { if (!fs.existsSync(path.join(projectDir, rel))) problems.push(`${rel} is missing. ${how}`); };
  need('out/main/index.js', 'Run "npx electron-vite build" in apps/desktop.');
  need('out/preload/index.cjs', 'Run "npx electron-vite build" in apps/desktop.');
  if (process.env.MINISUMMA_PACK_WITHOUT_RENDERER === '1') {
    console.warn('\n  WARNING: MINISUMMA_PACK_WITHOUT_RENDERER=1, packaging WITHOUT the renderer. The app will have no UI. Do not ship this.\n');
  } else {
    need('out/renderer/index.html', 'Run "npx electron-vite build" in apps/desktop (the renderer must build).');
  }
  need('../../packages/claude-integration/dist/capture.mjs', 'Run "npm run build:hook -w @minisumma/claude-integration".');
  for (const icon of ['build/icon.ico', 'build/icon.png', 'resources/icon.png', 'resources/tray.png']) need(icon, 'Run "node apps/desktop/scripts/make-icons.mjs".');

  // electron-builder cannot read the Electron version from a hoisted install with a ^range, so it is pinned in
  // electron-builder.yml. Make sure the pin is still what is installed.
  const installed = JSON.parse(fs.readFileSync(require.resolve('electron/package.json', { paths: [projectDir] }), 'utf8')).version;
  const pinned = context.packager.config.electronVersion;
  if (pinned !== installed) problems.push(`electron-builder.yml pins electronVersion ${pinned} but electron ${installed} is installed. Update electronVersion.`);

  let installedLinuxPty = null;
  if (platform === 'linux') {
    try {
      // The package restricts its "exports", so find its folder from the entry file (<package>/lib/index.js).
      installedLinuxPty = path.resolve(path.dirname(require.resolve('@lydell/node-pty-linux-x64', { paths: [projectDir] })), '..');
    } catch {
      problems.push('@lydell/node-pty-linux-x64 is not installed. Install dependencies on this machine (it is an optional dependency of @lydell/node-pty).');
    }
  }

  if (problems.length) throw new Error(`Cannot package:\n  - ${problems.join('\n  - ')}`);

  if (installedLinuxPty) {
    // Same place as the Windows package, so one rule in electron-builder.yml unpacks both.
    const staged = path.join(projectDir, 'build', 'native', 'node_modules', '@lydell', 'node-pty-linux-x64');
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.cpSync(installedLinuxPty, staged, { recursive: true, dereference: true });
  }

  if (platform === 'win32') {
    // Always from the verified tarball, also on a Windows machine, so every Windows build carries the same pty binaries.
    execFileSync(process.execPath, [path.join(projectDir, 'scripts', 'fetch-win-natives.mjs')], { stdio: 'inherit' });
  }
};
