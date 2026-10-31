#!/usr/bin/env node
// Mini-Summa PoC 0A: Claude Code hook capture.
//
// Contract:
//  * Always exits 0. Never prints a permission/continue decision.
//  * Reads the documented hook JSON from stdin, wraps it unchanged (after redaction)
//    with its own transport metadata, and writes it atomically (temp file + rename).
//  * The only stdout ever produced is SessionStart additionalContext, and only when
//    the session cwd resolves to a registered project.
//  * Any internal error is appended to <spool>/../capture-errors.log and swallowed.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactDeep, limitStrings } from '../lib/redact.mjs';
import { loadRegistry, detectEnv } from '../lib/registry.mjs';
import { clockDomain } from '../lib/clock.mjs';
import { REPORT_INSTRUCTION } from '../lib/protocol.mjs';

const CAPTURE_VERSION = 1;
const args = parseArgs(process.argv.slice(2));

try {
  main();
} catch (err) {
  logError(err);
}
process.exit(0);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    else out._event = argv[i];
  }
  return out;
}

function logError(err) {
  try {
    const spool = args.spool ?? process.env.MINI_SUMMA_SPOOL;
    if (!spool) return;
    fs.appendFileSync(path.join(path.dirname(spool), 'capture-errors.log'),
      `${new Date().toISOString()} ${String(err && err.stack || err).slice(0, 2000)}\n`, { mode: 0o600 });
  } catch { /* nothing else we can do */ }
}

function main() {
  const spool = args.spool ?? process.env.MINI_SUMMA_SPOOL;
  if (!spool) return;
  let text = '';
  try { text = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }

  const counter = { n: 0 };
  const trunc = { n: 0, bytes_dropped: 0 };
  let payload;
  let parseError = null;
  try {
    payload = JSON.parse(text);
    for (const k of ['tool_input', 'tool_response']) {
      if (k in payload) payload[k] = limitStrings(payload[k], 8192, trunc);
    }
    payload = redactDeep(payload, counter);
  } catch (e) {
    parseError = String(e.message).slice(0, 200);
    payload = { unparsed_stdin_prefix: redactDeep(text.slice(0, 2000), counter) };
  }

  const id = randomUUID();
  const mono = process.hrtime.bigint();
  const record = {
    schema: 'mini-summa.spool/1',
    transport: {
      transport_id: id,
      received_at: new Date().toISOString(),
      wall_ms: Date.now(),
      monotonic_ns: mono.toString(),
      capture_version: CAPTURE_VERSION,
      hook_arg: args._event ?? null,
      // handler_id names THIS registration. Two registrations of the capture hook must use different ids;
      // that is what lets the ingestor tell a duplicate delivery from two real identical events.
      handler_id: args.handler ?? null,
      env_id: args.env ?? detectEnv(),
      // monotonic_ns is comparable only within one clock domain (same environment and boot); null = not comparable
      clock_domain: clockDomain(args.env ?? detectEnv()),
      pid: process.pid,
      ppid: process.ppid,
      platform: process.platform,
      claude_project_dir: process.env.CLAUDE_PROJECT_DIR ?? null,
      claude_config_dir: process.env.CLAUDE_CONFIG_DIR ?? null,
      claude_code_remote: process.env.CLAUDE_CODE_REMOTE ?? null,
      redactions: counter.n,
      truncations: trunc.n,
      truncated_chars: trunc.bytes_dropped,
      parse_error: parseError,
    },
    payload,
  };

  ensureSpoolDir(spool);
  const name = `${mono.toString().padStart(20, '0')}-${id}.json`;
  const tmp = path.join(spool, `.tmp-${id}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  renameWithRetry(tmp, path.join(spool, name));

  if (payload.hook_event_name === 'SessionStart' && (args.registry ?? process.env.MINI_SUMMA_REGISTRY)) {
    emitSessionStartContext(payload);
  }
}

// On Windows a file that was written a moment ago can still be open in an antivirus scanner or the search indexer, and renaming it
// then fails with EPERM, EBUSY or EACCES. A record that is not renamed into place is a hook event Mini-Summa never hears about, so
// the rename is retried for about 1.3 seconds (the hook has 5) before the error is given up on and logged as before. Declared as
// functions with nothing outside them: main() runs before the rest of this file has been evaluated.
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; } catch (err) {
      const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
      if (!transient || attempt >= 7) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt); // 10, 20, 40 ... 640 ms
    }
  }
}

// The spool holds hook payloads: prompts, file contents, command output. Only the user may enter it (docs/CHANGES-FROM-POC.md,
// change 10). Directories this creates, parents included, are 0700; the files in it are 0600. The mode is not applied on Windows.
function ensureSpoolDir(spool) {
  fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
  tightenSpoolDir(spool);
}

// A spool directory made by an earlier version has the default mode (0755). It is tightened when it is plainly ours: a real
// directory (not a link), owned by this user, group- or world-accessible, holding only what the hook and the ingestor put there
// (pending files, temp files, done/, quarantine/). The directory somebody pointed --spool at by mistake is left as it is.
// Best effort: the capture must not fail over this, and the common case (already private) costs one lstat.
function tightenSpoolDir(spool) {
  if (process.platform === 'win32') return;
  try {
    // inside the function: main() runs before the declarations further down this file have been evaluated
    const OURS = /^(?:\d+-[0-9a-f-]{36}\.json|\.tmp-[0-9a-f-]{36}|done|quarantine)$/;
    const st = fs.lstatSync(spool);
    if (!st.isDirectory() || (st.mode & 0o077) === 0) return;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return;
    const dir = fs.opendirSync(spool);
    try {
      for (let entry; (entry = dir.readSync()) !== null;) if (!OURS.test(entry.name)) return;
    } finally { dir.closeSync(); }
    fs.chmodSync(spool, 0o700);
  } catch { /* leave the mode as it was */ }
}

function emitSessionStartContext(payload) {
  // Synchronous on purpose: the process exits right after main() returns.
  try {
    const registry = loadRegistry(args.registry ?? process.env.MINI_SUMMA_REGISTRY);
    const r = registry.resolve(process.env.CLAUDE_PROJECT_DIR || payload.cwd, args.env ?? detectEnv());
    if (!r.project) return;
    fs.writeSync(1, JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: REPORT_INSTRUCTION },
    }));
  } catch (err) { logError(err); }
}
