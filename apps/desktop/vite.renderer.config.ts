// Stand-alone Vite config for the renderer: dev server for screenshots and browser mode, and a build that mirrors what
// electron-vite produces. The core serves the build under /ui/, so assets are relative (base './').
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rendererRoot = fileURLToPath(new URL('./src/renderer', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  root: rendererRoot,
  base: './',
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    host: '127.0.0.1',
    port: 5174,
    // The vendored Summa-UI tokens live at <repo>/third_party, outside the renderer root.
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: fileURLToPath(new URL('./out/renderer', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
