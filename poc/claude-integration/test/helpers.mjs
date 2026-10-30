import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry } from '../src/lib/registry.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..');
export const S1 = '11111111-1111-4111-8111-111111111111';
export const S2 = '22222222-2222-4222-8222-222222222222';
export const S3 = '33333333-3333-4333-8333-333333333333';

export const registry = createRegistry({ projects: [
  { id: 'p-git', name: 'GitManager', roots: ['/w/GitManager'] },
  { id: 'p-herc', name: "Herc's Adventure", roots: ['/w/Herc', '/w/Herc-wt'] },
] }, { platform: 'linux', real: false });

// Wrap a fixture in raw-log entries the way Store.appendRaw would. Every entry gets a
// DISTINCT transport_id: a duplicate hook delivery is a different invocation.
export function loadFixture(name, startSeq = 1) {
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', `${name}.json`), 'utf8'));
  return fx.events.map((e, i) => e.kind === 'discovery'
    ? { seq: startSeq + i, kind: 'discovery', transport: { received_at: 'x', transport_id: `fx-${name}-${i}` }, payload: e.payload }
    : { seq: startSeq + i, kind: 'hook', transport: { transport_id: `fx-${name}-${i}`, monotonic_ns: String(1000 + (startSeq + i) * 10), claude_project_dir: null, handler_id: e.handler ?? 'h1' }, payload: e.payload });
}
export const labels = (r) => r.derived.filter((d) => d.label).map((d) => d.label);
export const kinds = (r) => r.derived.map((d) => d.kind);
