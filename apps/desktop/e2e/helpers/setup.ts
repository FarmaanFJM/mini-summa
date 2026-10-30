// Per test file, before the tests: a safety net. `scenario()` already cleans up after each test; this makes sure that a
// test written without it, or one that timed out, still leaves no Electron, fake Claude or temporary directory behind.
import { afterAll, afterEach } from 'vitest';
import { cleanupAll } from './app.ts';

afterEach(async () => { await cleanupAll(); });
afterAll(async () => { await cleanupAll(); });
