#!/usr/bin/env node
// Safety net for a public repository: fails when a tracked (or not-yet-ignored) file looks private.
// It does not replace reading what you stage. Run it before every push: `npm run guard`.
//
//   node scripts/publish-guard.mjs            scan the working tree (tracked + untracked, honouring .gitignore)
//   node scripts/publish-guard.mjs --staged   scan only what is staged
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staged = process.argv.includes('--staged');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const list = staged
  ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR').split('\n')
  : git('ls-files', '-co', '--exclude-standard').split('\n');
const files = list.filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));

// Files that must never be committed, whatever their content.
const FORBIDDEN_NAME = [
  [/\.(apk|aab|keystore|jks|p12|pfx|pem|key)$/i, 'signing material or build artifact'],
  [/(^|\/)google-services\.json$|GoogleService-Info\.plist$/, 'Firebase client configuration (belongs to the user)'],
  [/(^|\/)(service-account|fcm-service-account)[^/]*\.json$/i, 'service account credentials'],
  [/\.(exe|msi|dmg|AppImage|blockmap)$/i, 'installer or binary artifact'],
  [/\.(db|sqlite|sqlite3)(-wal|-shm)?$/i, 'runtime database'],
  [/(^|\/)(raw|derived)\.jsonl$|\.jsonl$/, 'raw event log or transcript'],
  [/(^|\/)\.env(\..*)?$/, 'environment file'],
  [/(^|\/)(spool[^/]*|managed-settings|secrets)\//, 'runtime data directory'],
];

const SYNTHETIC_UUID = /^(\d)\1{7}-\1{4}-4\1{3}-8\1{3}-\1{12}$|^00000000-0000-4000-8000-\d{12}$|^(11111111|22222222|33333333|44444444|55555555)-/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// A random UUID has about 14 distinct hex digits; fewer than six (aaaaaaaa-aaaa-4aaa-..., c2c2c2c2-...) is a made-up value,
// the chance that a real one looks like that is below one in a billion.
const isPlaceholderUuid = (u) => SYNTHETIC_UUID.test(u) || new Set(u.replace(/-/g, '').toLowerCase()).size <= 5;
// Obvious placeholders used by redaction tests are not secrets.
const FAKE = /abcdefghij|ABCDEFGH|SECRETSECRET|EXAMPLE|FAKE|fake|example|placeholder|0000000000|mini-summa-test/;

const CONTENT_RULES = [
  ['token-shaped string', /sk-ant-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{16,}|\bgithub_pat_|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]{24,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\r|\\n|\s)*[A-Za-z0-9+\/=]{40,}/],
  ['absolute home or temp path of a real machine', /(?:\/home\/(?!u\/|you\/|user\/mini-summa|me\/)[a-z][\w.-]*\/|\/Users\/(?!Some One|you\/|me\/)[A-Za-z][\w .-]*\/|C:\\Users\\(?!Some One|<|me\\|You\\)[A-Za-z][\w .-]*\\|\/root\/)/],
  ['harness or cloud session identifier', /claude-0\b|\/tmp\/claude-|scratchpad\/|session_01[A-Za-z0-9]{10,}|claude\.ai\/code\/session/],
  ['email address', /(?<![:\/A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?!example\.|users\.noreply\.github\.com|noreply\.|[0-9]x\.|github\.com[:/])[A-Za-z0-9-]+\.[a-z]{2,}/],
];

// Third-party and generated content that legitimately contains such strings is skipped for CONTENT rules only.
const SKIP_CONTENT = [/^third_party\//, /(^|\/)package-lock\.json$/, /\.(png|jpg|jpeg|gif|ico|icns|zip|woff2?|ttf|svg)$/i, /^scripts\/publish-guard\.mjs$/,
  /^poc\/claude-integration\/test\/publish-guard\.test\.mjs$/, /^packages\/claude-integration\/test\/publish-guard\.test\.mjs$/];

const problems = [];
for (const f of files) {
  for (const [re, why] of FORBIDDEN_NAME) if (re.test(f)) problems.push(`${f}: ${why}`);
  const full = path.join(root, f);
  const size = fs.statSync(full).size;
  if (size > 5 * 1024 * 1024 && !/^third_party\//.test(f)) problems.push(`${f}: larger than 5 MB (${(size / 1048576).toFixed(1)} MB)`);
  if (SKIP_CONTENT.some((re) => re.test(f))) continue;
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue; // binary
  // Tests, fixtures and demo data legitimately contain invented paths and ids. Secrets and harness identifiers are
  // still checked there; only the "real machine path" and "real-looking UUID" rules are relaxed.
  const synthetic = /(^|\/)(test|tests|__tests__|fixtures|examples|dev\/demo)\//.test(f) || /\.test\.(m?[jt]s|tsx)$/.test(f);
  for (const [name, re0] of CONTENT_RULES) {
    if (synthetic && name.startsWith('absolute home')) continue;
    const re = new RegExp(re0.source, 'g');
    for (const m of text.matchAll(re)) if (!FAKE.test(m[0])) problems.push(`${f}: ${name}: ${m[0].slice(0, 70)}`);
  }
  for (const u of text.match(UUID) ?? []) {
    if (!isPlaceholderUuid(u) && !synthetic) problems.push(`${f}: real-looking UUID ${u}`);
  }
}

if (problems.length) {
  console.error(`publish-guard: ${problems.length} problem(s)\n` + problems.map((p) => `  ${p}`).join('\n'));
  process.exit(1);
}
console.log(`publish-guard: ${files.length} file(s) checked, nothing private found${staged ? ' (staged)' : ''}`);
