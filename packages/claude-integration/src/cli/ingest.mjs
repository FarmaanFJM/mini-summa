#!/usr/bin/env node
// Ingest spooled hook files into the durable raw log, replay, and print NEW state transitions.
// Usage: node src/cli/ingest.mjs --spool DIR --store DIR --registry FILE [--watch]
import { Store } from '../lib/store.mjs';
import { loadRegistry } from '../lib/registry.mjs';
import { replay } from '../lib/reducer.mjs';

const a = { spool: [] };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k === '--watch') a.watch = true; else if (k === '--spool') a.spool.push(process.argv[++i]); else a[k.slice(2)] = process.argv[++i];
}
if (!a.spool.length || !a.store || !a.registry) {
  console.error('usage: ingest.mjs --spool DIR [--spool DIR ...] --store DIR --registry FILE [--watch]'); process.exit(2);
}
const registry = loadRegistry(a.registry);
const store = new Store(a.store);

function pass() {
  const res = { ingested: 0, already_ingested: 0, quarantined: 0 };
  for (const dir of a.spool) { const r = store.ingestSpool(dir); for (const k of Object.keys(res)) res[k] += r[k]; }
  const reducer = replay(store.raw, registry);
  const fresh = store.persist(reducer);
  for (const d of fresh) {
    if (d.kind === 'transition' || d.kind === 'report_ready' || d.kind === 'session_discovered') {
      console.log(`${d.label}${d.notify ? '   [notify]' : ''}${d.requires_user ? '   [needs you]' : ''}`);
    } else if (d.kind === 'late_event') console.log(`${d.project_name} / Session ${d.session_id.slice(0, 8)} / late ${d.hook_event} ignored for state`);
    else if (d.kind === 'report_duplicate') console.log(`${d.project_name} / Session ${d.session_id.slice(0, 8)} / duplicate report suppressed (${d.report_id})`);
    else console.log(`(${d.kind}) ${d.session_id}`);
  }
  return { res, reducer };
}
const first = pass();
console.error(`ingest: ${JSON.stringify(first.res)} raw=${store.raw.length} duplicates_flagged=${first.reducer.duplicates.length} torn_lines=${store.torn}`);
if (a.watch) setInterval(pass, 500);
