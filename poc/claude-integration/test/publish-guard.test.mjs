import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './helpers.mjs';

// Everything under this directory is meant to be published. This guard fails the build if a file looks private.
// It is a safety net, not a substitute for reading what you stage.
const SKIP = new Set(['node_modules', '.tmp-tests', '.git']);
function files(dir, out = []) {
  for (const n of fs.readdirSync(dir)) { if (SKIP.has(n)) continue; const p = path.join(dir, n); fs.statSync(p).isDirectory() ? files(p, out) : out.push(p); }
  return out;
}
const SYNTHETIC_UUID = /^(\d)\1{7}-\1{4}-4\1{3}-8\1{3}-\1{12}$|^00000000-0000-4000-8000-\d{12}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Obvious placeholders used by the redaction tests are not secrets. A real token never contains these.
const FAKE = /abcdefghij|ABCDEFGH|SECRETSECRET|EXAMPLE|FAKE/;
const rules = [
  ['token-shaped string', /sk-ant-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{16,}|\bgithub_pat_|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['absolute home or temp path of a real machine', /(?:\/home\/(?!u\/|you\/|user\/mini-summa)[a-z][\w.-]*\/|\/Users\/(?!Some One|you\/)[A-Za-z][\w .-]*\/|C:\\Users\\(?!Some One|<)[A-Za-z][\w .-]*\\|\/root\/|\/tmp\/claude)/],
  ['harness or cloud session identifier', /claude-0|scratchpad\/|session_01[A-Za-z0-9]{10,}|claude\.ai\/code\/session/],
  ['email address', /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9-]+\.[a-z]{2,}/],
];

test('no published file contains a secret, a real path, a harness identifier or an email', () => {
  const bad = [];
  for (const f of files(root)) {
    if (/\.(png|jpg|ico|zip)$/.test(f) || f.endsWith('publish-guard.test.mjs')) continue;
    const t = fs.readFileSync(f, 'utf8');
    for (const [name, re0] of rules) {
      const re = new RegExp(re0.source, 'g');
      for (const m of t.matchAll(re)) if (!FAKE.test(m[0])) bad.push(`${path.relative(root, f)}: ${name}: ${m[0].slice(0, 60)}`);
    }
    for (const u of t.match(UUID) ?? []) if (!SYNTHETIC_UUID.test(u)) bad.push(`${path.relative(root, f)}: real-looking UUID ${u}`);
  }
  assert.deepEqual(bad, []);
});

test('runtime artifacts are not present in the tree: no raw logs, spools, stores or transcripts', () => {
  const bad = files(root).filter((f) => /(^|[\\/])(raw|derived)\.jsonl$|\.jsonl$|[\\/]spool[^\\/]*[\\/]|[\\/]store[\\/]|[\\/]config-[^\\/]+[\\/]|[\\/]qualification[\\/]/.test(f));
  assert.deepEqual(bad.map((f) => path.relative(root, f)), []);
});

test('.gitignore exists and covers the runtime artifact classes', () => {
  const g = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const needle of ['raw.jsonl', 'spool', 'store/', 'config-', 'qualification', '*.jsonl', '.env']) assert.ok(g.includes(needle), needle);
});
