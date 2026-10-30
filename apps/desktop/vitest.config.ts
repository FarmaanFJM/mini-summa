import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

// Two projects: renderer component tests need a DOM, everything else (Electron main helpers) runs in plain Node.
export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'renderer',
          include: ['test/renderer/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          include: ['test/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'test/renderer/**'],
          environment: 'node',
        },
      },
    ],
  },
});
