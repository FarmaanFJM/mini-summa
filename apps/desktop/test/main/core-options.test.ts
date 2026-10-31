// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The embedded core must keep a stable address. The window's localStorage belongs to the origin (scheme, host AND port), so a
// random port on every start made the window forget the selected project, per-project choices and the setup dismissal on every
// restart; the browser extension's default address and `tailscale serve` also assume the core's preferred port. The core already
// prefers its default port and falls back to a free one only when that is taken, so the main process must not pin one.
// (The Electron acceptance suite proves it end to end: "the window reopens on the project that was selected".)
const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/main/index.ts'), 'utf8');

describe('the options the main process gives the embedded core', () => {
  const body = /function coreOptions\(\)[^{]*\{([\s\S]*?)\n\}\n/.exec(source)?.[1] ?? '';

  it('can be found', () => {
    expect(body).toContain("mode: 'embedded'");
  });

  it('leaves the port to the core, which prefers a stable one', () => {
    const code = body.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/\bport\s*:/);
  });
});
