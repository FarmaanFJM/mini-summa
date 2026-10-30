import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarker } from '../src/lib/marker.mjs';
import { createRegistry, normPath } from '../src/lib/registry.mjs';
import { redactDeep, limitStrings } from '../src/lib/redact.mjs';
import { normalizeAgents, validateAgents } from '../src/lib/discovery.mjs';

const M = (s, t = 'T') => `<!-- mini-summa:report status=${s} task="${t}" -->`;

test('marker: accepts complete, partial, blocked as the last non-empty line', () => {
  for (const s of ['complete', 'partial', 'blocked']) {
    const r = parseMarker(`body\n\n${M(s, 'Storage System')}\n\n`);
    assert.equal(r.valid, true); assert.equal(r.status, s); assert.equal(r.task, 'Storage System');
  }
});
test('marker: tolerates CRLF and trailing whitespace', () => {
  assert.equal(parseMarker(`x\r\n${M('complete')}  \r\n`).valid, true);
});
test('marker: rejects unknown status, quotes in title, extra text on the line', () => {
  assert.equal(parseMarker('<!-- mini-summa:report status=done task="T" -->').valid, false);
  assert.equal(parseMarker('<!-- mini-summa:report status=complete task="a"b" -->').valid, false);
  assert.equal(parseMarker(`prefix ${M('complete')}`).valid, false);
});
test('marker: marker earlier in the message is not trusted (misplaced)', () => {
  const r = parseMarker(`${M('complete')}\nand then I kept talking`);
  assert.equal(r.valid, false); assert.equal(r.reason, 'malformed_or_misplaced_marker');
});
test('marker: missing, empty and non-string messages are invalid, not thrown', () => {
  assert.equal(parseMarker(undefined).valid, false);
  assert.equal(parseMarker('').valid, false);
  assert.equal(parseMarker('   \n ').valid, false);
  assert.equal(parseMarker('plain progress update').reason, 'no_marker');
});

test('registry: longest root wins by path segment, not string prefix', () => {
  const r = createRegistry({ projects: [
    { id: 'a', name: 'A', roots: ['/w/app'] }, { id: 'b', name: 'B', roots: ['/w/app/packages/b'] },
  ] }, { platform: 'linux', real: false });
  assert.equal(r.resolve('/w/app/src').project.id, 'a');
  assert.equal(r.resolve('/w/app/packages/b/x').project.id, 'b');
  assert.equal(r.resolve('/w/application').project, null, 'string-prefix sibling must not match');
  assert.equal(r.resolve('/w/app/').project.id, 'a');
});
test('registry: unknown, missing cwd and ambiguous roots are explicit, not guessed', () => {
  const r = createRegistry({ projects: [{ id: 'a', name: 'A', roots: ['/x'] }, { id: 'b', name: 'B', roots: ['/x'] }] }, { platform: 'linux', real: false });
  assert.equal(r.resolve('/x/y').reason, 'ambiguous');
  assert.equal(r.resolve('/nope').reason, 'unregistered_directory');
  assert.equal(r.resolve(undefined).reason, 'no_cwd');
});
test('registry: several worktrees of one project resolve to the same project id', () => {
  const r = createRegistry({ projects: [{ id: 'h', name: 'H', roots: ['/w/Herc', '/w/Herc-wt'] }] }, { platform: 'linux', real: false });
  assert.equal(r.resolve('/w/Herc-wt/src').project.id, 'h');
  assert.equal(r.resolve('/w/Herc').project.id, 'h');
});
test('registry: Windows paths compare case-insensitively with either slash', () => {
  const r = createRegistry({ projects: [{ id: 'g', name: 'G', roots: ['C:\\Dev\\GitManager'] }] }, { platform: 'win32', real: false });
  assert.equal(r.resolve('c:/dev/gitmanager/src').project.id, 'g');
  assert.equal(r.resolve('C:\\Dev\\GitManager2').project, null);
  assert.equal(normPath('C:\\Dev\\X\\', 'win32', false), 'c:\\dev\\x');
});

test('redact: credential-shaped keys and token-shaped values are removed, benign text is untouched', () => {
  const c = { n: 0 };
  const out = redactDeep({ api_key: 'abc', Authorization: 'Bearer abcdefghijklmnop', note: 'token sk-ant-api03-ABCDEFGH1234 here',
    ok: 'hello world', nested: { password: 'p', list: ['ghp_ABCDEFGHIJKLMNOPQRST', 'fine'] } }, c);
  const s = JSON.stringify(out);
  assert.ok(!/sk-ant|ghp_|abcdefghijklmnop/.test(s));
  assert.equal(out.ok, 'hello world'); assert.equal(out.nested.list[1], 'fine');
  assert.ok(c.n >= 4);
});
test('redact: a normal report body passes through byte-identical', () => {
  const body = 'Ran 42 tests.\n\n## Implementation Report\n- fine\n<!-- mini-summa:report status=complete task="T" -->\n';
  assert.equal(redactDeep({ last_assistant_message: body }).last_assistant_message, body);
});
test('limitStrings truncates only oversized strings and reports it', () => {
  const st = { n: 0, bytes_dropped: 0 };
  const out = limitStrings({ a: 'x'.repeat(100), b: 'ok' }, 10, st);
  assert.equal(st.n, 1); assert.equal(out.b, 'ok'); assert.match(out.a, /truncated 90 chars/);
});

test('discovery: optional fields may be absent and are never assumed', () => {
  const raw = [{ cwd: '/a', kind: 'interactive', startedAt: 1 }, { cwd: '/b', kind: 'background', startedAt: 2, id: 'x', state: 'done', surprise: 1 }];
  const n = normalizeAgents(raw);
  assert.equal(n[0].sessionId, null); assert.equal(n[0].pid, null);
  assert.deepEqual(n[1]._extra_keys, ['surprise']);
  const v = validateAgents(raw);
  assert.equal(v.no_sessionId, 2); assert.deepEqual(v.undocumented_keys, ['surprise']); assert.deepEqual(v.missing_always, []);
  assert.throws(() => normalizeAgents({ not: 'array' }));
});

test('redact regression (found live): numeric counters such as context_tokens are not credentials', () => {
  const c = { n: 0 };
  const out = redactDeep({ context_tokens: 91234, max_tokens: 4096, token: 'abc', enabled_token_refresh: true }, c);
  assert.equal(out.context_tokens, 91234); assert.equal(out.max_tokens, 4096); assert.equal(out.enabled_token_refresh, true);
  assert.equal(out.token, '[REDACTED]'); assert.equal(c.n, 1);
});
