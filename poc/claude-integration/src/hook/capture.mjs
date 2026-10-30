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
      `${new Date().toISOString()} ${String(err && err.stack || err).slice(0, 2000)}\n`);
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

  fs.mkdirSync(spool, { recursive: true });
  const name = `${mono.toString().padStart(20, '0')}-${id}.json`;
  const tmp = path.join(spool, `.tmp-${id}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path.join(spool, name));

  if (payload.hook_event_name === 'SessionStart' && (args.registry ?? process.env.MINI_SUMMA_REGISTRY)) {
    emitSessionStartContext(payload);
  }
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
