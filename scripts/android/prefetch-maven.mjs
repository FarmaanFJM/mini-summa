#!/usr/bin/env node
// Fills a LOCAL, file-based Maven repository with files that Gradle could not download in time (typically because the
// registry answers HTTP 429 Too Many Requests), and checks every file against the checksums that the registry itself
// publishes next to it. Nothing is trusted that cannot be compared: a file without a published checksum, or whose
// checksum differs, is deleted and reported, never installed.
//
//   node scripts/android/prefetch-maven.mjs [--repo <dir>] [--log <gradle-output>]... [--gav <group:artifact:version>]...
//                                           [--signatures] [--attempts <n>] [--spacing <seconds>] [<download-url>]...
//
//   --repo <dir>     the local repository (default: $MINISUMMA_LOCAL_MAVEN, else ~/ms-maven)
//   --log <file>     a Gradle output file. Every file Gradle failed to get is fetched: "Could not GET '<url>'", the lines
//                    "Failed to get resource: GET. [HTTP 429: <url>)]" that --info prints, and, from a run with --offline,
//                    "No cached resource '<url>'" and "No cached version of <group:artifact:version>". Repeatable.
//   --gav <g:a:v>    a module whose files are wanted: its .pom, its .module (if published) and its main file (.aar when
//                    the pom says packaging aar, otherwise .jar; nothing for packaging pom). Repeatable.
//   --signatures     also fetch "<file>.asc" when the registry publishes one and verify it with gpg in a private, temporary
//                    keyring. A missing public key is looked up on keys.openpgp.org; if it is not available the signature is
//                    reported as "not verifiable here" (the checksum comparison still has to pass). A signature that does
//                    not match rejects the file.
//   --attempts <n>   tries per file when the registry answers 429 or 5xx (default 12; the wait doubles from 2 s up to 60 s,
//                    or follows a Retry-After header)
//   --spacing <s>    pause after each installed file (default 1)
//
// How it asks: plain `curl` with its default User-Agent, one request at a time, over the proxy and CA settings your
// environment already has. No header is changed, no certificate check is switched off, no other host is used.
//
// For every file Gradle wanted, the module's .pom (and .module when published) is fetched and verified too: Gradle takes the
// artifacts from the repository that supplied a module's metadata, so a local repository has to carry both.
// Pair it with scripts/android/local-maven.init.gradle (copy it to ~/.gradle/init.d/), which consults the local repository
// FIRST and keeps every normal repository behind it. Every installed file is recorded in <repo>/VERIFIED.tsv.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CENTRAL = 'https://repo.maven.apache.org/maven2/';
const GOOGLE = 'https://dl.google.com/dl/android/maven2/';
// Registries Gradle uses for this app. A failed URL must start with one of these; anything else is not touched.
const BASES = [CENTRAL, GOOGLE, 'https://plugins.gradle.org/m2/', 'https://www.jitpack.io/'];
const GOOGLE_GROUPS = /^(androidx\.|android\.arch\.|com\.android\.|com\.google\.android\.|com\.google\.firebase|com\.google\.testing\.platform)/;

const argv = process.argv.slice(2);
const logs = [];
const urls = [];
const gavs = [];
let repoDir = process.env.MINISUMMA_LOCAL_MAVEN ?? join(homedir(), 'ms-maven');
let attempts = 12;
let spacing = 1;
let signatures = false;
const die = (m) => { console.error(`prefetch-maven: ${m}`); process.exit(2); };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i] ?? die(`${a} needs a value`);
  if (a === '--repo') repoDir = next();
  else if (a === '--log') logs.push(next());
  else if (a === '--gav') gavs.push(next());
  else if (a === '--attempts') attempts = Number(next());
  else if (a === '--spacing') spacing = Number(next());
  else if (a === '--signatures') signatures = true;
  else if (a.startsWith('https://')) urls.push(a);
  else die(`unknown argument ${a}`);
}
if (!Number.isInteger(attempts) || attempts < 1) die('--attempts must be a whole number of at least 1');
if (!(spacing >= 0)) die('--spacing must be a number of seconds');
repoDir = resolve(repoDir);

// ---- what is wanted ----------------------------------------------------------------------------------------------------
const URL_IN_LOG = /(?:Could not (?:GET|HEAD) '|Failed to get resource: (?:GET|HEAD)\. \[HTTP \d+: |No cached resource ')(https?:\/\/[^'\s)]+)/g;
const GAV_IN_LOG = /No cached version of ([\w.-]+:[\w.-]+:[\w.+-]+) available for offline mode/g;
for (const f of logs) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(URL_IN_LOG)) urls.push(m[1]);
  for (const m of text.matchAll(GAV_IN_LOG)) gavs.push(m[1]);
}
const wantedUrls = [...new Set(urls)];
const wantedGavs = [...new Set(gavs)];
if (wantedUrls.length + wantedGavs.length === 0) die('nothing to do: pass download URLs, --gav coordinates, or --log <gradle output> that contains failed downloads.');

// ---- downloading -------------------------------------------------------------------------------------------------------
const sleep = (s) => spawnSync('sleep', [String(s)]);
const name = (u) => u.split('/').pop();
/** One URL to a file. Retries 429, 5xx and curl errors with a growing wait. Returns the final HTTP status (0 = never answered). */
function fetchTo(url, out) {
  let wait = 2;
  for (let n = 1; n <= attempts; n++) {
    const hdr = `${out}.hdr`;
    const r = spawnSync('curl', ['-sS', '--max-time', '600', '-o', out, '-D', hdr, '-w', '%{http_code}', url], { encoding: 'utf8' });
    const status = Number(r.stdout) || 0;
    let retryAfter = 0;
    try { retryAfter = Number(/^retry-after:\s*(\d+)/im.exec(readFileSync(hdr, 'utf8'))?.[1] ?? 0); } catch { /* none */ }
    rmSync(hdr, { force: true });
    if (status === 200 || status === 404) return status;
    if (status !== 429 && status < 500 && status !== 0) return status; // 401, 403 ...: not something to retry
    if (n === attempts) return status;
    console.log(`    ${status || 'no answer'} for ${name(url)}, waiting ${retryAfter || wait} s (try ${n}/${attempts})`);
    sleep(retryAfter || wait);
    wait = Math.min(wait * 2, 60);
  }
  return 0;
}

const digest = (file, algo) => createHash(algo).update(readFileSync(file)).digest('hex');
const HEX = { sha1: /^[0-9a-f]{40}$/, sha256: /^[0-9a-f]{64}$/ };
/** The checksum a registry publishes at "<url>.<algo>": the first word of that file, if it looks like one. */
function published(url, algo, tmp) {
  const f = join(tmp, `published.${algo}`);
  const status = fetchTo(`${url}.${algo}`, f);
  if (status === 404) return { value: null };
  if (status !== 200) return { error: `HTTP ${status || 'no answer'} for ${name(url)}.${algo}` };
  const word = readFileSync(f, 'utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return HEX[algo].test(word) ? { value: word } : { value: null };
}

function checkSignature(url, file, tmp) {
  const asc = join(tmp, 'file.asc');
  const status = fetchTo(`${url}.asc`, asc);
  if (status === 404) return { state: 'none published' };
  if (status !== 200) return { state: `signature file not fetched (HTTP ${status || 'no answer'})` };
  const home = mkdtempSync(join(tmpdir(), 'ms-gnupg-'));
  try {
    const verify = () => spawnSync('gpg', ['--homedir', home, '--batch', '--status-fd', '1', '--verify', asc, file], { encoding: 'utf8' });
    let v = verify();
    if (v.error) return { state: 'not verifiable here (gpg is not installed)' };
    let out = v.stdout ?? '';
    const missing = /\[GNUPG:\] NO_PUBKEY ([0-9A-F]+)/.exec(out)?.[1];
    if (missing) {
      const keyFile = join(tmp, 'key.asc');
      const ks = fetchTo(`https://keys.openpgp.org/vks/v1/by-keyid/${missing.slice(-16)}`, keyFile);
      if (ks !== 200) return { state: `not verifiable here (public key ${missing.slice(-16)} not available from keys.openpgp.org, HTTP ${ks || 'no answer'})` };
      spawnSync('gpg', ['--homedir', home, '--batch', '--import', keyFile], { encoding: 'utf8' });
      v = verify();
      out = v.stdout ?? '';
    }
    if (/\[GNUPG:\] BADSIG/.test(out)) return { state: 'BAD SIGNATURE', bad: true };
    const good = /\[GNUPG:\] VALIDSIG ([0-9A-F]{40})/.exec(out)?.[1];
    return { state: good ? `signed by key ${good} (key ownership not independently established)` : 'not verifiable here (gpg gave no verdict)' };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// ---- installing ----------------------------------------------------------------------------------------------------------
mkdirSync(repoDir, { recursive: true });
const ledger = join(repoDir, 'VERIFIED.tsv');
if (!existsSync(ledger)) writeFileSync(ledger, 'time\turl\tsha1\tsha256\tsignature\n');
const tmp = mkdtempSync(join(tmpdir(), 'ms-prefetch-'));
const stats = { installed: 0, already: 0 };
const problems = [];

/**
 * Downloads base+rel, compares it with the registry's published checksum(s) and installs it into the repository.
 * Returns 'ok', 'have', 'missing' (HTTP 404) or 'failed'.
 */
function install(base, rel) {
  const target = join(repoDir, rel);
  const full = base + rel;
  if (existsSync(target) && readFileSync(ledger, 'utf8').includes(`\t${full}\t${digest(target, 'sha1')}\t`)) { stats.already++; console.log(`  have     ${name(rel)}`); return 'have'; }
  const part = join(tmp, 'download.part');
  const status = fetchTo(full, part);
  if (status === 404) return 'missing';
  if (status !== 200) { problems.push(`${full}: HTTP ${status || 'no answer'}`); console.log(`  FAILED   ${name(rel)}: HTTP ${status || 'no answer'}`); return 'failed'; }
  const sums = { sha1: digest(part, 'sha1'), sha256: digest(part, 'sha256') };
  let compared = 0;
  let wrong = null;
  for (const algo of ['sha1', 'sha256']) {
    const pub = published(full, algo, tmp);
    if (pub.error) { wrong = pub.error; break; }
    if (pub.value === null) continue;
    compared++;
    if (pub.value !== sums[algo]) { wrong = `${algo} differs: downloaded ${sums[algo]}, registry publishes ${pub.value}`; break; }
  }
  if (!wrong && compared === 0) wrong = 'the registry publishes no checksum for this file, so it cannot be verified';
  let sig = '-';
  if (!wrong && signatures) {
    const s = checkSignature(full, part, tmp);
    sig = s.state;
    if (s.bad) wrong = 'its signature does not match the file';
  }
  if (!wrong && existsSync(target) && digest(target, 'sha1') !== sums.sha1) wrong = `a different file is already installed at ${target}`;
  if (wrong) { rmSync(part, { force: true }); problems.push(`${full}: ${wrong}`); console.log(`  REJECTED ${name(rel)}: ${wrong}`); return 'failed'; }
  mkdirSync(dirname(target), { recursive: true });
  renameSync(part, target);
  appendFileSync(ledger, `${new Date().toISOString()}\t${full}\t${sums.sha1}\t${sums.sha256}\t${sig}\n`);
  stats.installed++;
  console.log(`  OK       ${name(rel)}  sha1 ${sums.sha1}  (${compared} published checksum${compared > 1 ? 's' : ''} matched${signatures ? `; signature: ${sig}` : ''})`);
  if (spacing) sleep(spacing);
  return 'ok';
}

/** Installs the .pom and .module (when published) that belong with a file, and returns the pom's text. */
function installMetadata(base, dir, artifact, version) {
  const stem = `${dir}${artifact}-${version}`;
  const pom = install(base, `${stem}.pom`);
  const mod = install(base, `${stem}.module`);
  if (mod === 'missing') console.log(`  none     ${artifact}-${version}.module (not published)`);
  const pomFile = join(repoDir, `${stem}.pom`);
  return pom === 'ok' || pom === 'have' ? readFileSync(pomFile, 'utf8') : null;
}

for (const url of wantedUrls) {
  const base = BASES.find((b) => url.startsWith(b));
  if (!base) { console.log(`\nSKIP ${url}\n  not a known registry`); continue; }
  const rel = url.slice(base.length);
  if (/(^|\/)maven-metadata\.xml(\.[a-z0-9]+)?$/.test(rel)) { console.log(`\nSKIP ${rel}\n  version listings change over time and are not mirrored`); continue; }
  if (/\.(sha1|sha256|sha512|md5|asc)$/.test(rel)) continue;
  console.log(`\n${rel}`);
  const dir = rel.slice(0, rel.lastIndexOf('/') + 1);
  const parts = dir.split('/').filter(Boolean);
  const version = parts[parts.length - 1];
  const artifact = parts[parts.length - 2];
  install(base, rel);
  if (!/\.(pom|module)$/.test(rel)) installMetadata(base, dir, artifact, version);
  else installMetadata(base, dir, artifact, version);
}

for (const gav of wantedGavs) {
  const [group, artifact, version] = gav.split(':');
  console.log(`\n${gav}`);
  const dir = `${group.replaceAll('.', '/')}/${artifact}/${version}/`;
  const order = GOOGLE_GROUPS.test(group) ? [GOOGLE, CENTRAL] : [CENTRAL, GOOGLE];
  let done = false;
  for (const base of order) {
    const pomRel = `${dir}${artifact}-${version}.pom`;
    const pom = install(base, pomRel);
    if (pom === 'missing') { console.log(`  not at ${new URL(base).hostname}`); continue; }
    if (pom === 'failed') break;
    const text = readFileSync(join(repoDir, pomRel), 'utf8');
    const mod = install(base, `${dir}${artifact}-${version}.module`);
    if (mod === 'missing') console.log(`  none     ${artifact}-${version}.module (not published)`);
    const packaging = /<packaging>\s*([\w.-]+)\s*<\/packaging>/.exec(text)?.[1] ?? 'jar';
    if (packaging !== 'pom') {
      const ext = packaging === 'aar' ? 'aar' : 'jar';
      const main = install(base, `${dir}${artifact}-${version}.${ext}`);
      // Kotlin Multiplatform roots and other redirecting modules have a pom but no file of their own: Gradle follows the .module.
      if (main === 'missing') console.log(`  none     ${artifact}-${version}.${ext} (no file of its own; ${mod === 'missing' ? 'not published' : 'see the .module'})`);
    }
    done = true;
    break;
  }
  if (!done && !problems.some((p) => p.includes(`/${artifact}-${version}.`))) problems.push(`${gav}: not found at ${order.map((b) => new URL(b).hostname).join(' or ')}`);
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\nprefetch-maven: ${stats.installed} installed, ${stats.already} already there, ${problems.length} problem(s). Repository: ${repoDir}`);
for (const pr of problems) console.log(`  ! ${pr}`);
process.exit(problems.length ? 1 : 0);
