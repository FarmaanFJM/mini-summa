import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Workspace packages ship TypeScript source, so they are compiled into the main bundle. So are the pure JavaScript
// dependencies of the core. Everything else listed in package.json `dependencies` stays external (electron-vite's
// default): the native pty (it picks a platform package at run time), `ws` (optional native add-ons loaded in try/catch)
// and the renderer-only libraries, which the main bundle never imports.
const BUNDLED = [
  '@minisumma/core', '@minisumma/shared', '@minisumma/storage', '@minisumma/claude-integration',
  'hono', '@hono/node-server', 'zod',
];

const here = import.meta.dirname;
const rendererEntry = resolve(here, 'src/renderer/index.html');
const hasRenderer = existsSync(rendererEntry);
if (!hasRenderer) {
  console.warn(`[electron.vite.config] ${rendererEntry} does not exist yet: building main and preload only.`);
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: BUNDLED },
      rolldownOptions: {
        // node:sqlite is not in module.builtinModules on every Node, so say so explicitly.
        external: [/^node:/, /^@lydell\/node-pty/, 'ws', 'bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    build: {
      // A sandboxed preload cannot require anything but 'electron': bundle the rest into the one file.
      externalizeDeps: false,
      lib: { entry: resolve(here, 'src/preload/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
      rolldownOptions: { output: { format: 'cjs' } },
    },
  },
  ...(hasRenderer
    ? {
        renderer: {
          root: resolve(here, 'src/renderer'),
          plugins: [react()],
        },
      }
    : {}),
});
