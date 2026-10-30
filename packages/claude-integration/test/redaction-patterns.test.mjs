import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { redactString, redactDeep } from '../src/lib/redact.mjs';
import { root, S1 } from './helpers.mjs';
import { tmpDir } from './tmp-helpers.mjs';

// CHANGE 9 (docs/CHANGES-FROM-POC.md): the proof of concept hid six token shapes and every value under a credential-like key.
// A review found a long list of ordinary ways to write a secret that it left in the spool: other providers' tokens, a
// password in a URL or after `curl -u`, `--password=...`, `DB_PASSWORD=...`, a private key block. This file proves they are
// hidden, counted once, and that ordinary text is not touched: the look-alikes below are measured, not guessed.
//
// The secrets in this file are assembled at run time from pieces. No file in the package may contain a complete token-shaped
// string (test/publish-guard.test.mjs reads all of them), and the secret scanners of the hosts we push to would not know
// these are not real either.

const R = '[REDACTED]';
const j = (...parts) => parts.join('');
// An unremarkable run of letters and digits of length n (the default seed is not a word, a key or a hash).
const fill = (n, seed = 'Qw7Zr2LpXc9VbN4mKd8sTy3HgF6J') => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const run = (input) => { const counter = { n: 0 }; const out = redactString(input, counter); return { out, n: counter.n }; };

// What the proof of concept did, copied from poc/claude-integration/src/lib/redact.mjs: the reference for "left alone before,
// left alone now" and for the counts of the shapes that were already hidden.
const POC_RES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
const KEY_RE = /(token|secret|passw(or)?d|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
function pocString(s, counter) { let out = s; for (const re of POC_RES) out = out.replace(re, () => { counter.n++; return '[REDACTED]'; }); return out; }
function pocDeep(value, counter) {
  if (typeof value === 'string') return pocString(value, counter);
  if (Array.isArray(value)) return value.map((v) => pocDeep(v, counter));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (KEY_RE.test(k) && typeof v !== 'number' && typeof v !== 'boolean') { counter.n++; out[k] = '[REDACTED]'; } else out[k] = pocDeep(v, counter);
    }
    return out;
  }
  return value;
}
const poc = (input) => { const counter = { n: 0 }; const out = pocString(input, counter); return { out, n: counter.n }; };

// `[input, expected]` pairs that are checked one by one, with the secret bodies that must be gone from the output.
function expectAll(pairs, gone = []) {
  const failures = [];
  for (const [input, expected, count = 1] of pairs) {
    const { out, n } = run(input);
    if (out !== expected || n !== count) failures.push(`${JSON.stringify(input)}\n    got  ${JSON.stringify(out)} (${n})\n    want ${JSON.stringify(expected)} (${count})`);
    for (const g of gone) if (out.includes(g)) failures.push(`${JSON.stringify(input)} still contains ${g}`);
  }
  assert.deepEqual(failures, []);
}

// ---- token shapes -------------------------------------------------------------------------------------------------------

const SHAPES = {
  'OpenAI project key': j('sk-pr', 'oj-', fill(48)),
  'OpenAI service account key': j('sk-sv', 'cacct-', fill(40)),
  'OpenAI admin key': j('sk-ad', 'min-', fill(40)),
  'Stripe live secret key': j('sk_li', 've_', fill(24)),
  'Stripe live restricted key': j('rk_li', 've_', fill(24)),
  'Stripe test secret key': j('sk_te', 'st_', fill(24)),
  'Stripe test restricted key': j('rk_te', 'st_', fill(24)),
  'GitLab personal access token': j('glp', 'at-', fill(20)),
  'Slack bot token': j('xo', 'xb-', '123456789012-1234567890123-', fill(24)),
  'Slack user token': j('xo', 'xp-', '123456789012-1234567890123-1234567890123-', fill(32)),
  'Slack app token (xoxa)': j('xo', 'xa-', '2-123456789012-', fill(24)),
  'Slack refresh token (xoxr)': j('xo', 'xr-', '123456789012-', fill(24)),
  'Slack legacy token (xoxs)': j('xo', 'xs-', '123456789012-1234567890123-', fill(24)),
  'Slack app-level token': j('xa', 'pp-', '1-A01234567-1234567890-', fill(40)),
  'Slack incoming webhook': j('https://hooks.sl', 'ack.com/services/', 'T01234567/B01234567/', fill(24)),
  'Slack incoming webhook without a scheme': j('hooks.sl', 'ack.com/services/', 'T01234567/B01234567/', fill(24)),
  'Google API key': j('AI', 'za', 'Sy', fill(33)),
  'npm access token': j('np', 'm_', fill(36)),
  'Hugging Face token': j('h', 'f_', fill(34)),
};

test('CHANGE 9: provider tokens with a recognisable prefix are hidden wherever they appear, once each', () => {
  const contexts = [['', ''], ['key: ', ' and more'], ['"', '"'], ["'", "'"], ['=', ';'], ['(', ')'], ['\n', '\n'], ['x ', '\r\ny'], ['<', '>'], ['`', '`'], ['[', ']']];
  const pairs = [];
  for (const secret of Object.values(SHAPES)) for (const [before, after] of contexts) pairs.push([`${before}${secret}${after}`, `${before}${R}${after}`]);
  expectAll(pairs, [fill(20)]);
  // none of the shapes is hidden only in part: nothing of the generated body survives
  for (const [name, secret] of Object.entries(SHAPES)) assert.equal(run(`a ${secret} b`).out, `a ${R} b`, name);
});

test('CHANGE 9: the token shapes are not hidden when only their prefix is mentioned', () => {
  const same = [j('sk-pr', 'oj-'), j('sk_li', 've_'), j('glp', 'at-'), j('xo', 'xb-'), j('AI', 'za'), j('np', 'm_'), j('h', 'f_'), 'the sk_live_ prefix', 'a glpat token', 'xoxb tokens look like this',
    j('hooks.sl', 'ack.com/services/'), 'sk_live', 'pk_live_ keys are public', j('np', 'm_config_registry'), j('np', 'm_package_name'), j('h', 'f_hub_download'), 'AIzaBella'];
  expectAll(same.map((s) => [s, s, 0]));
});

// ---- secrets in the way they are typed ----------------------------------------------------------------------------------

test('CHANGE 9: aws_secret_access_key assignments in INI, YAML, JSON text, env and aws-cli form', () => {
  const key = fill(40, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY');
  expectAll([
    [`aws_secret_access_key = ${key}`, `aws_secret_access_key = ${R}`],
    [`aws_secret_access_key=${key}`, `aws_secret_access_key=${R}`],
    [`aws_secret_access_key: ${key}`, `aws_secret_access_key: ${R}`],
    [`AWS_SECRET_ACCESS_KEY=${key}`, `AWS_SECRET_ACCESS_KEY=${R}`],
    [`export AWS_SECRET_ACCESS_KEY="${key}"`, `export AWS_SECRET_ACCESS_KEY="${R}"`],
    [`{"aws_secret_access_key": "${key}"}`, `{"aws_secret_access_key": "${R}"}`],
    [`aws configure set aws_secret_access_key ${key}`, `aws configure set aws_secret_access_key ${R}`],
    [`[default]\naws_access_key_id = ID\naws_secret_access_key = ${key}\nregion = eu-west-1\n`, `[default]\naws_access_key_id = ID\naws_secret_access_key = ${R}\nregion = eu-west-1\n`],
    ['aws_secret_access_key = abc123', `aws_secret_access_key = ${R}`],
  ], [key.slice(5, 25)]);
  expectAll([['aws_secret_access_key is required', 'aws_secret_access_key is required', 0], ['aws_secret_access_key: string', 'aws_secret_access_key: string', 0],
    ['set aws_secret_access_key to the value from IAM', 'set aws_secret_access_key to the value from IAM', 0], ['aws_secret_access_key=', 'aws_secret_access_key=', 0]]);
});

test('CHANGE 9: Authorization: Basic with its base64 credentials', () => {
  const b64 = Buffer.from(`svc-user:${fill(12)}`).toString('base64');
  expectAll([
    [`Authorization: Basic ${b64}`, `Authorization: Basic ${R}`],
    [`authorization: basic ${b64}`, `authorization: basic ${R}`],
    [`curl -H "Authorization: Basic ${b64}" https://example.com/`, `curl -H "Authorization: Basic ${R}" https://example.com/`],
    [`{'Authorization': 'Basic ${b64}'}`, `{'Authorization': 'Basic ${R}'}`],
    [`Authorization=Basic ${b64}`, `Authorization=Basic ${R}`],
    [`Authorization: Basic ${b64},`, `Authorization: Basic ${R},`],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', `Authorization: Basic ${R}`],
  ], [b64.slice(4, 20)]);
  // the scheme named in a sentence, or a placeholder for the credentials, is not a credential
  const prose = ['Authorization: Basic Authentication', 'Authorization: Basic authentication', 'Authorization: Basic scheme', 'Authorization: Basic ${creds}', 'Authorization: Basic <base64>',
    'Authorization: Basic base64(user:pass)', 'Authorization: Basic', 'HTTP Basic auth', 'Basic abc123'];
  expectAll(prose.map((s) => [s, s, 0]));
});

test('CHANGE 9: curl -u user:password in every spelling, and only for curl', () => {
  expectAll([
    ['curl -u admin:hunter2 https://example.com/', `curl -u ${R} https://example.com/`],
    ['curl -u "admin:hunter2" https://example.com/', `curl -u ${R} https://example.com/`],
    ["curl -u 'admin:hunter two' https://example.com/", `curl -u ${R} https://example.com/`],
    ['curl --user admin:hunter2 https://example.com/', `curl --user ${R} https://example.com/`],
    ['curl -sSu admin:hunter2 https://example.com/', `curl -sSu ${R} https://example.com/`],
    ['curl -fsSL -u admin:hunter2 https://example.com/', `curl -fsSL -u ${R} https://example.com/`],
    ['curl -s https://example.com/ -u admin:hunter2', `curl -s https://example.com/ -u ${R}`],
    ['cd /w && curl -u admin:hunter2 https://example.com/ | jq .', `cd /w && curl -u ${R} https://example.com/ | jq .`],
    ['curl -u admin:hunter2 -u other:hunter3 https://example.com/', `curl -u ${R} -u ${R} https://example.com/`, 2],
    ['curl https://example.com/ \\\n  -H "Accept: application/json" \\\n  -u admin:hunter2', `curl https://example.com/ \\\n  -H "Accept: application/json" \\\n  -u ${R}`],
    ['curl https://example.com/ \\\r\n  -u admin:hunter2', `curl https://example.com/ \\\r\n  -u ${R}`],
    ['curl https://example.com/ \\\n-u admin:hunter2', `curl https://example.com/ \\\n-u ${R}`],
    ['curl -u "$USER:hunter2" https://example.com/', `curl -u ${R} https://example.com/`],
    ["curl -u 'admin:$ecret' https://example.com/", `curl -u ${R} https://example.com/`],
  ], ['hunter']);
  const same = ['curl -u admin https://example.com/', 'curl -u admin: https://example.com/', 'curl -u "$USER:$PASS" https://example.com/', 'curl -u "admin:$PASS" https://example.com/', 'curl -u "admin:${PASS}" https://example.com/',
    'curl --user-agent "a:b" https://example.com/', 'docker run -u 1000:1000 img', 'ps -u root:wheel', 'sudo -u postgres psql', 'diff -u a b', 'sort -u names.txt', 'git log -u', 'pip install -U pkg',
    'echo curl is not run here\nls -u user:pass', 'ssh -u admin:hunter2 host'];
  expectAll(same.map((s) => [s, s, 0]));
});

test('CHANGE 9: a password in a URL: scheme://user:password@host', () => {
  expectAll([
    ['postgres://admin:hunter2@example.com:5432/app', `postgres://${R}@example.com:5432/app`],
    ['DATABASE_URL=postgres://admin:hunter2@example.com/app', `DATABASE_URL=postgres://${R}@example.com/app`],
    ['redis://:hunter2@example.com:6379', `redis://${R}@example.com:6379`],
    ['mongodb+srv://admin:hunter2@example.com/db?retryWrites=true', `mongodb+srv://${R}@example.com/db?retryWrites=true`],
    ['git clone https://oauth2:hunter2@example.com/o/r.git', `git clone https://${R}@example.com/o/r.git`],
    ['ftp://anonymous:guest@example.com/', `ftp://${R}@example.com/`],
    ['https://user:p%40ss%3Aword@example.com/x?y=1#z', `https://${R}@example.com/x?y=1#z`],
    ['see (https://admin:hunter2@example.com/) and "ftp://a:b@example.com"', `see (https://${R}@example.com/) and "ftp://${R}@example.com"`, 2],
    ['proxy http://127.0.0.1:41234@evil.example/', `proxy http://${R}@evil.example/`],
    ['https://[::1]:hunter2@example.com/', `https://${R}@example.com/`],
  ], ['hunter', 'guest']);
  const same = ['https://example.com/path?x=1&y=2', 'http://localhost:3000/api', 'https://example.com:8080/a@b', 'https://user@example.com', 'redis://:6379', 'postgres://localhost/db',
    'http://[::1]:47811', 'http://[::1]:47811/x@y', 'http://user:pass', 'ssh://' + j('git', '@', 'github.com') + '/owner/repo.git', j('git', '@', 'github.com') + ':owner/repo.git', 'mailto:someone@example.org',
    'file:///tmp/x', 'webpack://./src/foo.js', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html', 'data:image/png;base64,iVBORw0KGgo=', 'https://example.com/?next=https://example.org/'];
  expectAll(same.map((s) => [s, s, 0]));
});

test('CHANGE 9: Azure AccountKey and SharedAccessKey', () => {
  const key = fill(64, 'Zm9vYmFyYmF6cXV4Cg') + '==';
  expectAll([
    [`DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${key};EndpointSuffix=core.windows.net`, `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${R};EndpointSuffix=core.windows.net`],
    [`Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=${fill(44)}=`, `Endpoint=sb://example.servicebus.windows.net/;SharedAccessKeyName=root;SharedAccessKey=${R}`],
    ['accountkey=abc123def', `accountkey=${R}`],
  ], [key.slice(0, 30)]);
  expectAll([['AccountName=acct;EndpointSuffix=core.windows.net', 'AccountName=acct;EndpointSuffix=core.windows.net', 0], ['AccountKey=short', 'AccountKey=short', 0], ['AccountKey=<key>', 'AccountKey=<key>', 0],
    ['SharedAccessKeyName=RootManageSharedAccessKey', 'SharedAccessKeyName=RootManageSharedAccessKey', 0]]);
});

test('CHANGE 9: --password=hunter2 and its siblings, with = or a space, quoted or not', () => {
  const pairs = [];
  for (const flag of ['--password', '--passwd', '--token', '--secret', '--api-key']) {
    pairs.push([`tool ${flag}=hunter2 --verbose`, `tool ${flag}=${R} --verbose`]);
    pairs.push([`tool ${flag} hunter2 --verbose`, `tool ${flag} ${R} --verbose`]);
    pairs.push([`tool ${flag}="two words" x`, `tool ${flag}=${R} x`]);
    pairs.push([`tool ${flag} 'two words' x`, `tool ${flag} ${R} x`]);
    pairs.push([`tool ${flag} "two words"`, `tool ${flag} ${R}`]);
    pairs.push([`tool ${flag}=abc123\nnext line`, `tool ${flag}=${R}\nnext line`]);
    pairs.push([`tool\t${flag}\t12345`, `tool\t${flag}\t${R}`]);
  }
  // with an = a prefix in front of the secret word is still the flag of a secret: --client-secret, --db-password, --auth-token
  for (const flag of ['--client-secret', '--db-password', '--registry-password', '--auth-token', '--access-token', '--openai-api-key']) pairs.push([`tool ${flag}=hunter2`, `tool ${flag}=${R}`]);
  pairs.push(['mysql --user=root --password=hunter2 --host=db', `mysql --user=root --password=${R} --host=db`]);
  pairs.push(['tool --password password', `tool --password ${R}`]);
  pairs.push(['tool --token abc123, then more', `tool --token ${R} then more`]);
  expectAll(pairs, ['hunter', 'two words', 'abc123']);
  // only the five bare names take a value after a space, a prefix does not: --ask-vault-password is a switch
  expectAll([['ansible-playbook --ask-vault-password site.yml', 'ansible-playbook --ask-vault-password site.yml', 0], ['tool --client-secret hunter2', 'tool --client-secret hunter2', 0]]);
  const same = ['--passport=abc', '--passport abc', '--tokens 5', '--tokens=5', '--max-tokens 4096', '--max-tokens=4096', '--secret-name=foo', '--secret-name foo', '--token-file=/tmp/t',
    '--token-file /tmp/t', '--password-file=/tmp/p', '--password-stdin', 'docker login --password-stdin', '--no-password', '--no-token', '--password', 'the --token flag', 'the --secret flag',
    'the --token flag sets the token', 'the --password option is deprecated', 'Use --token to pass it', '--password is required', '--token must be set', '--api-key value', '--token <token>', '--password PASSWORD',
    '--password=<password>', '--token=$TOKEN', '--token="$TOKEN"', '--password "$PASSWORD"', '--secret ${SECRET}', '--api-key $API_KEY', '--token $(cat t)', '--token -', '--password --other',
    'run with --token', 'run with --token.', '--api-key, --token or --password', '(--token)', '`--token`', '--token\nvalue', '--password=...', 'x--token=abc', '---token=abc'];
  expectAll(same.map((s) => [s, s, 0]));
});

test('CHANGE 9: NAME=VALUE where the name ends in a secret word, in the shapes people paste', () => {
  const names = ['DB_PASSWORD', 'PASSWORD', 'DB_PASSWD', 'GPG_PASSPHRASE', 'GITHUB_TOKEN', 'NPM_TOKEN', 'TOKEN', 'STRIPE_SECRET', 'SECRET', 'CLIENT_SECRET', 'API_KEY', 'APIKEY', 'OPENAI_API_KEY',
    'STRIPE_SECRET_KEY', 'SECRETKEY', 'AWS_ACCESS_KEY', 'SSH_PRIVATE_KEY', 'MINISUMMA_KEYSTORE_PASSWORD'];
  const forms = [['export ', 'hunter2', ''], ['', 'hunter2', ''], ['', '"two words"', ''], ['', "'two words'", ''], ['', 'hunter2', ' ./run.sh'], ['docker run -e ', 'hunter2', ' img'], ['ENV ', 'hunter2', ''],
    ['set ', 'hunter2', ''], ['$env:', '"hunter2"', ''], ['- ', 'hunter2', ''], ['env ', 'hunter2', ' node app.js'], ['', 'hunter2', ';echo done'], ['(', 'hunter2', ')'], ['', '12345678', ''], ['', "'$ecret'", '']];
  const pairs = [];
  for (const name of names) for (const [before, value, after] of forms) pairs.push([`${before}${name}=${value}${after}`, `${before}${name}=${R}${after}`]);
  pairs.push(['API_KEY=abc', `API_KEY=${R}`], ['API_KEY=your-key', `API_KEY=${R}`], ['DB_PASSWORD=hunter2\nDB_USER=root\nNODE_ENV=production\n', `DB_PASSWORD=${R}\nDB_USER=root\nNODE_ENV=production\n`]);
  expectAll(pairs, ['hunter', 'two words']);
  const same = ['MAX_TOKENS=100', 'TOKEN_LIMIT=5000', 'PASSWORD_MIN_LENGTH=8', 'TOKEN_TTL=3600', 'SECRET_NAME=prod-secret', 'KEY=value', 'API_KEY_HEADER=x-api-key', 'AUTH_TOKEN_URL=https://auth.example.com/token',
    'NODE_ENV=production', 'PATH=/usr/bin:/bin', 'PWD=/w/project', 'USERNAME=root', 'DB_PASSWORD=', 'DB_PASSWORD= ./run', 'export TOKEN', 'export DB_PASSWORD=$DB_PASSWORD', 'export DB_PASSWORD="$DB_PASSWORD"',
    'export DB_PASSWORD="${DB_PASSWORD}"', 'API_KEY=$(cat key.txt)', 'GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}', 'PASSWORD=...', 'PASSWORD=\u2026', 'API_KEY=****', 'API_KEY=<your key>', 'SECRET=true', 'USE_TOKEN=false',
    'if (TOKEN==expected) {}', 'if (PASSWORD!="x") {}', 'TOKEN >= 5', 'TOKEN += 1', 'TOKEN=>', 'const TOKEN = process.env.TOKEN;', 'Password=hunter2', 'password=hunter2', 'myDB_PASSWORD=x', 'db_PASSWORD=x',
    '_PASSWORD=x', '9PASSWORD=x'];
  expectAll(same.map((s) => [s, s, 0]));
});

test('CHANGE 9: a bearer token of 6 characters or more, not only 12', () => {
  const tokenless = ['Bearer', 'Bearer abc', 'Bearer tokens', 'Bearer Tokens are described in RFC 6750', 'Bearer scheme', 'Bearer headers.', 'Bearer ${TOKEN}', 'Bearer $TOKEN', 'Bearer <token>', 'Bearer {{ token }}',
    'bearer abc123', 'the bearer of bad news', 'WWW-Authenticate: Bearer realm="api"', 'WWW-Authenticate: Bearer error="invalid_token"', 'Authorization: Bearer <token>', 'Authorization: Bearer tokens',
    'Authorization: Bearer abcde', 'Authorization: required'];
  expectAll(tokenless.map((s) => [s, s, 0]));
  expectAll([
    ['Bearer abc123', R], ['Bearer abcdef', R], ['Bearer secret', R], ['Bearer tok-secret', R], ['Bearer at-prod', R], ['Bearer a.b.c.d', R], ['Bearer tokens1', R],
    ['Authorization: Bearer abc123', `Authorization: ${R}`],
    ['curl -H "Authorization: Bearer secret" https://example.com/', `curl -H "Authorization: ${R}" https://example.com/`],
    ['authorization: bearer abc123', `authorization: bearer ${R}`],
    ['AUTHORIZATION: BEARER secret', `AUTHORIZATION: BEARER ${R}`],
    ['{"headers": {"Authorization": "Bearer abc123"}}', `{"headers": {"Authorization": "${R}"}}`],
    // as before: 12 characters or more, whatever they spell
    [`Bearer ${fill(40)}`, R], ['Bearer authentication', R],
  ]);
});

// ---- private keys -------------------------------------------------------------------------------------------------------

const DASHES = '-----';
const header = (type) => `${DASHES}BEGIN ${type}${DASHES}`;
const footer = (type) => `${DASHES}END ${type}${DASHES}`;
const body = (n) => { const lines = []; for (let i = 0; i < n; i += 64) lines.push(fill(Math.min(64, n - i), 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC+/=')); return lines.join('\n'); };
const TYPES = ['RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK'];

test('CHANGE 9: a PEM private key block is hidden as a whole, for every type, with CRLF line ends or escaped newlines', () => {
  const pairs = [];
  for (const type of TYPES) {
    const block = `${header(type)}\n${body(1600)}\n${footer(type)}`;
    pairs.push([block, R], [`before\n${block}\nafter`, `before\n${R}\nafter`], [`before\r\n${block.replace(/\n/g, '\r\n')}\r\nafter`, `before\r\n${R}\r\nafter`]);
    pairs.push([`{"private_key_text": "${block.replace(/\n/g, '\\n')}\\n", "next": 1}`, `{"private_key_text": "${R}\\n", "next": 1}`]);
    pairs.push([`key = "${block.replace(/\n/g, '\\n')}"`, `key = "${R}"`]);
  }
  pairs.push([`${header('RSA PRIVATE KEY')}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF\n\n${body(300)}\n${footer('RSA PRIVATE KEY')}\nafter`, `${R}\nafter`]);
  pairs.push([`${header('PRIVATE KEY')}\n${footer('PRIVATE KEY')}`, R]);
  expectAll(pairs, [fill(32, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC+/=').slice(0, 30)]);
  // two blocks in one string are two redactions
  const two = `${header('RSA PRIVATE KEY')}\n${body(200)}\n${footer('RSA PRIVATE KEY')}\nmiddle\n${header('EC PRIVATE KEY')}\n${body(200)}\n${footer('EC PRIVATE KEY')}`;
  assert.deepEqual(run(two), { out: `${R}\nmiddle\n${R}`, n: 2 });
});

test('CHANGE 9: a PEM block with no END line (a capture cut short) is hidden up to a cap of 4096 characters', () => {
  const h = header('OPENSSH PRIVATE KEY');
  // the body of a cut-off key, then the text that follows it
  assert.deepEqual(run(`before\n${h}\n${body(900)}\n\nand the next paragraph says more`), { out: `before\n${R}\n\nand the next paragraph says more`, n: 1 });
  assert.deepEqual(run(`${h}\n${body(900)}`), { out: R, n: 1 });
  assert.deepEqual(run(`${h}\n${body(900)}[truncated 5000 chars]`), { out: `${R}[truncated 5000 chars]`, n: 1 });
  assert.deepEqual(run(`${h}\\n${body(900).replace(/\n/g, '\\n')}`), { out: R, n: 1 });
  // the cap: what is hidden is the header and at most the 4096 characters after it (a line break at the cut stays outside),
  // so the rest of an oversized body is left in the output, and the cost does not grow with it
  const tail = (input) => input.slice(h.length + 4096);
  const capped = (input) => {
    const { out, n } = run(input);
    assert.equal(n, 1);
    assert.ok(out.startsWith(R) && out.endsWith(tail(input)), 'the part beyond the cap is untouched');
    assert.ok(out.length - R.length - tail(input).length <= 2, 'only a line break at the cut stays between the marker and the rest');
  };
  capped(`${h}\n${body(10000)}`);
  // an END line that is further away than the cap is not looked for
  capped(`${h}\n${body(6000)}\n${footer('OPENSSH PRIVATE KEY')}`);
  // a block that fits is hidden whole, up to its END line, even when it is close to the cap
  const nearCap = `${header('PRIVATE KEY')}\n${body(3300)}\n${footer('PRIVATE KEY')}\ntail`;
  assert.equal(run(nearCap).out, `${R}\ntail`);
});

test('CHANGE 9: text that only mentions a key block, and the other PEM types, are left alone', () => {
  const same = [
    `${header('PUBLIC KEY')}\n${body(300)}\n${footer('PUBLIC KEY')}`,
    `${header('CERTIFICATE')}\n${body(900)}\n${footer('CERTIFICATE')}`,
    `${header('CERTIFICATE REQUEST')}\n${body(300)}\n${footer('CERTIFICATE REQUEST')}`,
    `a header that starts with ${header('PRIVATE KEY')}.`,
    `the line ${header('RSA PRIVATE KEY')} marks the start`,
    `"${header('PRIVATE KEY')}"`,
    `echo "${header('PRIVATE KEY')}" > key.pem`,
    `${header('PRIVATE KEY')}\nMII`,
    // code that builds a block holds something that is not base64 between the two lines
    `key: \`${header('PRIVATE KEY')}\\n\${data.toString("base64")}\\n${footer('PRIVATE KEY')}\``,
    `${header('PRIVATE KEY')}\n$KEY\n${footer('PRIVATE KEY')}`,
    `${header('PRIVATE KEY')}\n{{ key }}\n${footer('PRIVATE KEY')}`,
    `${DASHES}BEGIN`,
  ];
  expectAll(same.map((s) => [s, s, 0]));
});

// ---- counting -----------------------------------------------------------------------------------------------------------

test('CHANGE 9: every hidden value adds one to the count, and a value that two rules could hide is counted once', () => {
  const classic = [j('sk-an', 't-api03-', fill(20)), j('gh', 'p_', fill(30)), j('AK', 'IA', 'ABCDEFGHIJKLMNOP'), `Bearer ${fill(30)}`, j('ey', 'J', fill(12), '.', fill(12), '.', fill(12))];
  for (const secret of classic) assert.deepEqual(run(`x ${secret} y`), { out: `x ${R} y`, n: 1 }, 'a shape the proof of concept already hid is still one redaction');
  const three = `curl -u admin:hunter2 https://example.com/ && export DB_PASSWORD=hunter3 && npm config set //registry.example.org/:_authToken ${SHAPES['npm access token']}`;
  assert.deepEqual(run(three).n, 3);
  // the same secret reachable by two rules: the first to see it hides it, the second finds the marker and leaves it
  const sk = j('sk-an', 't-api03-', fill(20)); const gh = j('gh', 'p_', fill(30)); const npm = SHAPES['npm access token']; const aws = fill(40, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY');
  expectAll([
    [`API_KEY=${sk}`, `API_KEY=${R}`], [`export GITHUB_TOKEN=${gh}`, `export GITHUB_TOKEN=${R}`], [`NPM_TOKEN=${npm}`, `NPM_TOKEN=${R}`], [`STRIPE_SECRET_KEY=${SHAPES['Stripe live secret key']}`, `STRIPE_SECRET_KEY=${R}`],
    [`AWS_SECRET_ACCESS_KEY=${aws}`, `AWS_SECRET_ACCESS_KEY=${R}`], [`curl -u admin:${sk} https://example.com/`, `curl -u admin:${R} https://example.com/`],
    [`curl -u admin:${gh} https://example.com/`, `curl -u admin:${R} https://example.com/`], [`--token=${gh}`, `--token=${R}`], [`--api-key ${sk}`, `--api-key ${R}`], [`--password=${sk}`, `--password=${R}`],
    [`postgres://admin:${gh}@example.com/db`, `postgres://admin:${R}@example.com/db`], [`https://x-access-token:${gh}@example.com/o/r.git`, `https://x-access-token:${R}@example.com/o/r.git`],
    [`Authorization: Bearer ${gh}`, `Authorization: ${R}`], [`Authorization: Bearer ${sk}`, `Authorization: Bearer ${R}`],
    [`Authorization: Bearer ${fill(40)}`, `Authorization: ${R}`], [`"Authorization: Bearer ${fill(40)}"`, `"Authorization: ${R}"`],
    [`${header('PRIVATE KEY')}\n${body(300)}\n${footer('PRIVATE KEY')}`, R], [`PRIVATE_KEY="${header('PRIVATE KEY')}\n${body(300)}\n${footer('PRIVATE KEY')}"`, `PRIVATE_KEY="${R}"`],
    [`SLACK_WEBHOOK_URL=${SHAPES['Slack incoming webhook']}`, `SLACK_WEBHOOK_URL=${R}`],
  ]);
});

test('CHANGE 9: hiding is idempotent: redacted text is neither changed nor counted again', () => {
  const sk = j('sk-an', 't-api03-', fill(20));
  const inputs = [...Object.values(SHAPES), `API_KEY=${sk}`, 'curl -u admin:hunter2 https://example.com/', 'postgres://admin:hunter2@example.com/db', 'export DB_PASSWORD=hunter2', 'tool --token abc123',
    'tool --password=hunter2', 'Bearer abc123', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'aws_secret_access_key = abc123def456', 'AccountKey=abcdef123456', `${header('PRIVATE KEY')}\n${body(300)}\n${footer('PRIVATE KEY')}`,
    `${header('PRIVATE KEY')}\n${body(300)}`, 'tool --client-secret=hunter2'];
  for (const input of inputs) {
    const once = run(input);
    assert.ok(once.n >= 1 && once.out.includes(R), input);
    assert.deepEqual(run(once.out), { out: once.out, n: 0 }, `hiding ${JSON.stringify(input)} again changed it: ${JSON.stringify(run(once.out).out)}`);
  }
});

test('CHANGE 9: redactDeep counts the new shapes along with the credential-like keys, and the keys still win', () => {
  const counter = { n: 0 };
  const out = redactDeep({
    session_id: S1,
    tool_input: { command: `curl -u admin:hunter2 https://example.com/ && echo ok`, env: { DB_PASSWORD: 'x' }, list: ['plain', `export API_KEY=abc123`, { note: 'hi', url: 'postgres://u:p@example.com/db' }] },
    tool_response: { stdout: `${header('PRIVATE KEY')}\n${body(300)}\n${footer('PRIVATE KEY')}\n`, context_tokens: 123, password: false, Authorization: `Basic ${fill(20)}` },
  }, counter);
  assert.deepEqual(out, {
    session_id: S1,
    tool_input: { command: `curl -u ${R} https://example.com/ && echo ok`, env: { DB_PASSWORD: R }, list: ['plain', `export API_KEY=${R}`, { note: 'hi', url: `postgres://${R}@example.com/db` }] },
    tool_response: { stdout: `${R}\n`, context_tokens: 123, password: false, Authorization: R },
  });
  assert.equal(counter.n, 6); // curl, DB_PASSWORD key, API_KEY, url, PEM block, Authorization key
});

test('CHANGE 9: nothing the proof of concept left alone is changed, and what it hid is hidden the same way and counted the same', () => {
  const classic = [j('sk-an', 't-api03-', fill(20)), j('sk-', fill(30)), `Bearer ${fill(30)}`, j('gh', 'p_', fill(30)), j('github', '_pat_', fill(30)), j('AK', 'IA', 'ABCDEFGHIJKLMNOP'), j('ey', 'J', fill(12), '.', fill(12), '.', fill(12))];
  const frames = [(s) => s, (s) => `a ${s} b`, (s) => `${s}\n${s}`, (s) => `{"x": "${s}", "y": "${s}"}`, (s) => `token ${s}`, (s) => `Authorization: ${s}`];
  for (const secret of classic) for (const frame of frames) {
    const input = frame(secret);
    assert.deepEqual(run(input), poc(input), JSON.stringify(input));
  }
  const prose = ['The quick brown fox', 'tokens and passwords are not secrets when they are words', 'const a = { b: 1 };', '/home/u/.mini-summa/spool', 'C:\\Users\\Some One\\AppData', '', ' ', '\n', 'x'.repeat(10000), '# heading\n\n- item\n'];
  for (const input of prose) assert.deepEqual(run(input), poc(input), JSON.stringify(input.slice(0, 40)));
});

// ---- ordinary text ------------------------------------------------------------------------------------------------------

test('CHANGE 9: ordinary text is left alone: prose, code, type annotations, file names, hashes, ids, URLs, flags', () => {
  const uuid = randomUUID();
  const lookAlikes = {
    prose: ['The password must be at least 8 characters long.', 'Reset your password from the settings page, then sign in again.', 'password is required', 'Enter a password: ', "the user's password was rejected",
      'Your token expired. Run login again to get a new token.', 'We count tokens per request; tokens are billed.', 'tokens: 1200', 'max_tokens = 4096', 'context_tokens: 51234', 'input tokens, output tokens, cache tokens',
      'the secret is stored in the keychain', 'a secret santa', 'API keys are listed in the dashboard', 'Authorization is checked on every request', 'Basic authentication is not supported', 'HTTP Basic auth',
      'Use the Authorization header with the Bearer scheme', 'Do not commit the .env file with the password in it', 'private key rotation is quarterly', 'a bearer instrument', 'Bearer tokens are sent in a header',
      'curl is installed', 'the Bearer token', 'passwords: none', 'secrets are rotated', 'Tokens are cheap.'],
    typeAnnotations: ['password: string', 'password?: string;', 'token: string | null', 'secret: Buffer', 'apiKey: string;', 'interface Config { password: string; token?: string }', "const password: string = '';", 'let token = null;',
      'def login(password: str, token: str = None):', 'password = input("Password: ")', 'const { password, token } = req.body;', 'user.password = hash(password)', 'password=password', 'token=token, secret=secret',
      'connect(user=user, password=password)', 'headers: { Authorization: token }', 'headers: { Authorization: `Bearer ${token}` }', 'req.headers.authorization', 'const token = getToken();', 'if (!password) return;',
      'private key: PrivateKey', 'api_key: Optional[str] = None', 'token_type: "bearer"', 'export type Credentials = { password: string }', 'function check(password, hash) { return verify(password, hash); }',
      'const secret = crypto.randomBytes(32);', 'static final String TOKEN = "";', 'var apiKey = config.apiKey;', 'password_hash TEXT NOT NULL,', 'SELECT token FROM sessions WHERE id = ?',
      'if (token === undefined) throw new Error("no token");', 'throw new Error(`invalid password for ${user}`)', 'print(f"token: {token}")', '$password = Read-Host -AsSecureString'],
    fileNames: ['.env', '.env.example', 'password.txt', 'secret.json', 'token.ts', 'src/lib/redact.mjs', 'credentials.json', 'tokens.css', 'id_rsa', 'id_rsa.pub', 'private-key.pem', 'secrets/prod.yaml', 'npm-debug.log',
      'cat ~/.ssh/id_ed25519.pub', 'ls -la secrets/', 'git add .env.example', 'open passwords.csv', 'rm -f token.json', 'src/auth/tokens.ts', 'docs/passwords.md', 'config/secrets.example.yml',
      'node_modules/.bin/tokenizer', 'AWS credentials file: ~/.aws/credentials', 'ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519'],
    hashesAndIds: ['commit 0123456789abcdef0123456789abcdef01234567', 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', `uuid ${uuid}`, `session ${S1}`,
      j('integrity sha512-', fill(86), '=='), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', j('abc', 'AI', 'zaBella'), 'sk-learn', 'task-ant-colony', 'xox', 'xoxo', 'npm_config_cache', 'hf_hub'],
    imagesAndData: ['![logo](assets/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.png)', '<img src="/images/logo@2x.png">', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      `background: url(data:image/svg+xml;base64,${fill(400, 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIx')})`, fill(2000, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB')],
    flagsAndEnv: ['--passport=abc', '--tokens 5', '--max-tokens 4096', '--token-file=/tmp/t', '--password-stdin', '--secret-name foo', 'MAX_TOKENS=100', 'TOKEN_LIMIT=5000', 'PASSWORD_MIN_LENGTH=8', 'KEY=value', 'NODE_ENV=production',
      'PATH=/usr/bin:/bin', 'export DB_PASSWORD=$DB_PASSWORD', 'API_KEY=$(cat key.txt)', 'if (TOKEN==expected) {}', 'docker run -u 1000:1000 img', 'curl -u admin https://example.com/', 'HOME=/home/u', 'LANG=en_US.UTF-8',
      'CI=true npm test', 'NODE_OPTIONS=--max-old-space-size=4096', 'FORCE_COLOR=1', 'DEBUG=*', 'git commit -m "rotate the password policy"', 'npm run build -- --token-budget 5', 'grep -r "password" src/',
      'curl -fsSL https://example.com/install.sh | sh', 'curl -H "Accept: application/json" https://example.com/', 'wget --user-agent=Mozilla https://example.com/'],
    urls: ['https://example.com/path?x=1&y=2', 'http://localhost:3000/api', 'https://example.com:8080/a@b', 'https://user@example.com', 'file:///tmp/file.txt', 'mailto:someone@example.org', 'http://[::1]:47811',
      'git+https://example.com/o/r.git#semver:^1.0.0', 'see https://example.com/docs/passwords#reset', 'https://example.com/?token=expired', 'https://example.com/a/b/c.html#section-2', 'ws://localhost:41234/stream',
      'http://192.168.1.5:47811/health', 'https://registry.npmjs.org/@scope%2fpkg', 'postgres://localhost:5432/app', 'redis://localhost', 'amqp://example.com:5672/vhost', 'jdbc:postgresql://example.com:5432/app'],
    miscellaneous: ['2026-10-30T16:41:12.483Z Error: EEXIST: file already exists', '12:34:56', 'a:b:c', 'key: value', 'user: admin', 'name=value&other=thing', '{"password": null}', '{"tokens": 12}', 'Cookie policy',
      'x-api-version: 2', 'Retry-After: 30', 'Content-Type: application/json; charset=utf-8', 'WWW-Authenticate: Basic realm="api"', 'WWW-Authenticate: Bearer realm="api", error="invalid_token"'],
  };
  const failures = [];
  let count = 0;
  for (const [group, list] of Object.entries(lookAlikes)) for (const input of list) {
    count++;
    const { out, n } = run(input);
    if (out !== input || n !== 0) failures.push(`${group}: ${JSON.stringify(input.slice(0, 80))} became ${JSON.stringify(out.slice(0, 80))} (${n})`);
    if (poc(input).out !== input) failures.push(`${group}: the proof of concept already changed ${JSON.stringify(input.slice(0, 80))}: this list should hold only text both leave alone`);
  }
  assert.deepEqual(failures, []);
  assert.ok(count >= 150, `expected a broad list of look-alikes, got ${count}`);
});

test('CHANGE 9: every fixture and example in the package comes out of the redactor exactly as it did before this change', () => {
  const files = [];
  for (const dir of ['fixtures', 'examples']) {
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
    walk(path.join(root, dir));
  }
  assert.ok(files.length >= 20, `expected the fixtures and the examples, found ${files.length} files`);
  let bytes = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8'); bytes += text.length;
    assert.deepEqual(run(text), poc(text), `${path.relative(root, file)} as text`);
    if (file.endsWith('.json')) {
      const a = { n: 0 }; const b = { n: 0 };
      assert.deepEqual(redactDeep(JSON.parse(text), a), pocDeep(JSON.parse(text), b), `${path.relative(root, file)} as a document`);
      assert.equal(a.n, b.n, `${path.relative(root, file)}: redaction count`);
    }
  }
  assert.ok(bytes > 20000, 'a real corpus, not a few empty files');
});

// ---- cost ---------------------------------------------------------------------------------------------------------------

// The hostile inputs, one megabyte each. Written as a self-contained function so that they can be run in a child process: a rule
// that backtracked badly would not fail a test in this process, it would never return.
function hostileInputs() {
  const MB = 1 << 20;
  const rep = (unit, size = MB) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const key = '-----BEGIN PRIVATE KEY-----';
  return {
    'one long capitalised run': rep('A'), 'names with no value': rep('FOO_BAR_TOKEN '), 'an unterminated quote': `NAME="${rep('x')}`, 'quotes after names': rep("N_TOKEN='"),
    'headers with no body': rep('-----BEGIN '), 'headers of keys': rep(key), 'one header and a huge body': `${key}\n${rep('QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n')}`,
    'Bearer and space': `Bearer${rep(' ')}`, 'Bearer again': rep('Bearer '), 'Authorization and space': `Authorization: Basic${rep(' ')}`, 'scheme and colons': `a://${rep(':')}`, 'userinfo again and again': rep('http://u:p@h '),
    'flags': rep('--token '), 'a flag with spaces': `--token${rep(' ')}`, 'a long flag name': `--${rep('a-')}`, 'dashes': rep('--a'), '-u again and again': `curl ${rep(' -u a:b')}`,
    '-u far from curl': `curl ${rep('x')}${rep(' -u a:b', MB / 2)}`, 'continued lines': `curl${rep(' \\\n')} -u a:b`, 'aws names': rep('aws_secret_access_key = '), 'prefixes': rep('sk-'), 'more prefixes': rep('sk-proj-'),
    'slack': rep('hooks.slack.com/services/A/'), 'equals': rep('A='), 'unicode': rep('\u2018\u201c'),
  };
}

test('CHANGE 9: hostile input costs time in proportion to its size, not to its square', () => {
  const moduleUrl = pathToFileURL(path.join(root, 'src', 'lib', 'redact.mjs')).href;
  const script = `import { redactString } from ${JSON.stringify(moduleUrl)};
const hostile = (${hostileInputs.toString()})();
for (const [name, input] of Object.entries(hostile)) {
  console.log('START ' + name);
  const t = process.hrtime.bigint(); redactString(input, { n: 0 });
  console.log('DONE ' + Math.round(Number(process.hrtime.bigint() - t) / 1e6) + ' ' + name);
}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 180000 });
  const lines = (r.stdout ?? '').split('\n').filter(Boolean);
  const started = lines.filter((l) => l.startsWith('START ')).map((l) => l.slice(6)); const done = lines.filter((l) => l.startsWith('DONE '));
  assert.ok(!r.error && r.status === 0, `the redactor did not finish within 180 s on "${started[started.length - 1]}" (a rule backtracks): ${r.error?.message ?? r.stderr}`);
  assert.equal(done.length, started.length);
  assert.ok(done.length >= 25, 'the whole list ran');
  // a rule that backtracked badly would take minutes on a megabyte; the ones above take well under a second each
  const slow = done.map((l) => l.split(' ')).filter(([, ms]) => Number(ms) > 10000).map(([, ms, ...name]) => `${name.join(' ')}: ${ms} ms`);
  assert.deepEqual(slow, []);
});

// ---- end to end ---------------------------------------------------------------------------------------------------------

test('CHANGE 9: through the real hook: the secrets are not in the spool file, the redactions are counted, ordinary text is byte for byte', (t) => {
  const d = tmpDir(t, 'redact-patterns');
  const spool = path.join(d, 'spool');
  const env = { ...process.env }; for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_REMOTE', 'MINI_SUMMA_SPOOL', 'MINI_SUMMA_REGISTRY']) delete env[k];
  const hook = (payload) => {
    const before = new Set(fs.existsSync(spool) ? fs.readdirSync(spool) : []);
    const r = spawnSync(process.execPath, [path.join(root, 'src', 'hook', 'capture.mjs'), '--spool', spool, '--env', 'posix', '--handler', 'h1', payload.hook_event_name],
      { input: JSON.stringify(payload), encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    const [name] = fs.readdirSync(spool).filter((f) => f.endsWith('.json') && !before.has(f));
    const text = fs.readFileSync(path.join(spool, name), 'utf8');
    return { text, record: JSON.parse(text) };
  };
  const base = { session_id: S1, cwd: '/w/GitManager' };
  const pw = fill(14, 'hUnT3rTwOpAsS'); const pw2 = fill(14, 'zXcVbNmAsDfGh'); const npm = SHAPES['npm access token']; const pem = `${header('RSA PRIVATE KEY')}\n${body(1600)}\n${footer('RSA PRIVATE KEY')}`;

  const pre = hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1',
    tool_input: { command: `curl -u svc:${pw} https://example.com/ && export DB_PASSWORD=${pw2} && npm config set //registry.example.org/:_authToken ${npm}`, description: 'call the service' } });
  assert.equal(pre.record.transport.redactions, 3);
  assert.equal(pre.record.payload.tool_input.command, `curl -u ${R} https://example.com/ && export DB_PASSWORD=${R} && npm config set //registry.example.org/:_authToken ${R}`);
  assert.equal(pre.record.payload.tool_input.description, 'call the service');
  for (const secret of [pw, pw2, npm]) assert.ok(!pre.text.includes(secret.slice(2)), 'the spool file must not hold any part of the secret');

  const post = hook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't2', tool_input: { file_path: 'key.pem' }, tool_response: { content: `${pem}\n` } });
  assert.equal(post.record.transport.redactions, 1);
  assert.equal(post.record.payload.tool_response.content, `${R}\n`);
  assert.ok(!post.text.includes('MIIEvQIBADANBgkq'), 'no part of the key body is in the spool file');

  const stop = hook({ ...base, hook_event_name: 'Stop', prompt_id: 'p1', last_assistant_message: 'I called the API with Bearer abc123 and it worked.', background_tasks: [], session_crons: [] });
  assert.equal(stop.record.transport.redactions, 1);
  assert.equal(stop.record.payload.last_assistant_message, `I called the API with ${R} and it worked.`);

  const ordinary = 'The password must be 8 characters; tokens expire; set --max-tokens 4096 and MAX_TOKENS=100; see https://example.com/docs/passwords. password: string';
  const plain = hook({ ...base, hook_event_name: 'UserPromptSubmit', prompt_id: 'p2', prompt: ordinary });
  assert.equal(plain.record.transport.redactions, 0);
  assert.equal(plain.record.payload.prompt, ordinary);
});
