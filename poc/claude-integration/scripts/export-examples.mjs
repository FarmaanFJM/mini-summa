#!/usr/bin/env node
// Export one REAL captured payload per hook event, sanitized for publication.
// usage: node scripts/export-examples.mjs --store DIR --out DIR --mask DIR [--mask DIR ...]
// Sanitizing: every UUID is replaced by a stable synthetic one, every masked directory (plain or as Claude encodes it
// in project folder names) becomes <SCRATCH>, and any remaining absolute home-style path is rejected, not published.
import fs from 'node:fs';
import path from 'node:path';

const a = { mask: [] };
for (let i = 2; i < process.argv.length; i += 2) { const k = process.argv[i].slice(2); if (k === 'mask') a.mask.push(process.argv[i + 1]); else a[k] = process.argv[i + 1]; }
const raw = fs.readFileSync(path.join(a.store, 'raw.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.kind === 'hook');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ids = new Map();
const fake = (u) => { const k = u.toLowerCase(); if (!ids.has(k)) ids.set(k, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`); return ids.get(k); };
const encode = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
export function sanitize(obj, masks) {
  // scratchpad_dir is a temp path chosen by the host; its value carries no information worth publishing.
  let t = JSON.stringify(obj).replace(/"scratchpad_dir":"[^"]*"/g, '"scratchpad_dir":"<SCRATCHPAD-DIR>"');
  for (const m of masks) { t = t.split(encode(m)).join('<SCRATCH-ENCODED>'); t = t.split(m).join('<SCRATCH>'); }
  t = t.replace(UUID, fake);
  if (/\/(tmp|home|root|Users)\/|[A-Za-z]:\\\\Users/.test(t.replace(/<SCRATCH>[^"]*/g, ''))) { const m = t.replace(/<SCRATCH>[^"]*/g, '').match(/.{0,40}(\/(tmp|home|root|Users)\/|[A-Za-z]:\\\\Users).{0,40}/); throw new Error('unmasked absolute path remains; refusing to publish: ' + (m && m[0])); }
  return JSON.parse(t);
}
fs.mkdirSync(a.out, { recursive: true });
const picked = {};
for (const e of raw) {
  const ev = e.payload.hook_event_name;
  if (e.transport.redactions > 0) continue; // never publish a payload the redactor had to alter
  const score = (x) => (x.payload.last_assistant_message?.includes('mini-summa:report') ? 2 : 0) + (x.payload.model ? 1 : 0);
  if (!picked[ev] || score(e) > score(picked[ev])) picked[ev] = e;
}
for (const [ev, e] of Object.entries(picked)) {
  const out = sanitize({ note: 'REAL payload captured from Claude Code, sanitized: paths are masked and session, prompt and tool-use ids are replaced by synthetic ones. The transport block is added by the capture script.',
    transport: { ...e.transport, transport_id: '<uuid>', pid: 0, ppid: 0 }, payload: e.payload }, a.mask);
  fs.writeFileSync(path.join(a.out, `${ev}.json`), JSON.stringify(out, null, 2) + '\n');
}
console.log('exported:', Object.keys(picked).join(', '));
