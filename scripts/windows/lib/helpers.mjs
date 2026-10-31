// Pure(ish) helpers for scripts/windows/installed-smoke.mjs. Nothing here needs Windows, Electron or a running core, so
// scripts/windows/lib/helpers.test.mjs exercises all of it on any OS (node --test).
import fs from 'node:fs';
import path from 'node:path';

export const STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', NOT_RUN: 'NOT RUN', INFO: 'INFO' });

/** Collects check results. `phase` is the CLI phase that produced a result, so a phase can exit non-zero for its own FAILs only. */
export class Results {
  constructor(items = []) { this.items = items; }
  add(phase, id, title, status, details = []) {
    if (!Object.values(STATUS).includes(status)) throw new Error(`Unknown status ${status}`);
    const lines = (Array.isArray(details) ? details : [details]).map(String).filter((l) => l.length > 0);
    const item = { phase, id, title, status, details: lines, at: new Date().toISOString() };
    this.items.push(item);
    return item;
  }
  failures(phase) { return this.items.filter((i) => i.status === STATUS.FAIL && (!phase || i.phase === phase)); }
  counts() {
    const c = { PASS: 0, FAIL: 0, 'NOT RUN': 0, INFO: 0 };
    for (const i of this.items) c[i.status] += 1;
    return c;
  }
  toJSON() { return this.items; }
}

export function formatLine(item) {
  const head = `[${item.status}] ${item.id} ${item.title}`;
  return item.details.length ? `${head}\n${item.details.map((d) => `    ${d}`).join('\n')}` : head;
}

/** Shell-free, ASCII-only escaping of a table cell. */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** What this run can never show. Kept next to the renderer so the report and docs/WINDOWS_CI.md say the same thing. */
export const NOT_PROVEN = [
  'Anything that needs a signed-in ChatGPT or Claude account: the embedded ChatGPT page, a linked ChatGPT Project opening the right page, the Cloud tab, a real Claude session answering.',
  'A human seeing a toast, or clicking one. Check 5 only shows that the application asked Windows for a toast and Windows did not refuse; the runner has no person and no real notification centre.',
  'SmartScreen. The installer is not code-signed; the reputation prompt appears only for a file that came from a browser download (Mark of the Web), and this job never downloads it that way.',
  'Real window layout: whether controls overlap, whether the ChatGPT page is covered, how the window looks at all. No screenshot is judged here.',
  'Windows display scaling or mixed-DPI monitors. The runner has one virtual display at one scale.',
  'Interaction: typing, pasting, dragging the divider, ConPTY behaviour under a real terminal session, Ctrl+C, resize. Nothing is clicked or typed in the window.',
  'A managed Claude session on Windows. The packaged build has its test seams off, so no fake Claude can be injected; the real Claude Code CLI is not authenticated here.',
  'Behaviour on a normal desktop edition of Windows 10/11 as a standard (non-administrator) user. The runner account is an administrator on a Server image.',
];

/**
 * @param {{ results: Results|object[], meta: Record<string, string|null|undefined> }} input
 */
export function renderReport({ results, meta }) {
  const items = Array.isArray(results) ? results : results.items;
  const counts = { PASS: 0, FAIL: 0, 'NOT RUN': 0, INFO: 0 };
  for (const i of items) counts[i.status] += 1;
  const out = [];
  out.push('# Mini-Summa on native Windows: installed-application checks');
  out.push('');
  const verdict = counts.FAIL > 0 ? `${counts.FAIL} check(s) FAILED` : 'no check failed';
  out.push(`**Result: ${verdict}.** PASS ${counts.PASS}, FAIL ${counts.FAIL}, NOT RUN ${counts['NOT RUN']}, INFO ${counts.INFO}.`);
  out.push('');
  out.push('This ran the INSTALLED application (silent per-user install of the installer built in the same workflow) on a GitHub-hosted');
  out.push('`windows-latest` runner. It proves only what the PASS lines say; see "What this does NOT prove" below.');
  out.push('');
  out.push('| Field | Value |');
  out.push('| --- | --- |');
  for (const [k, v] of Object.entries(meta ?? {})) out.push(`| ${cell(k)} | ${cell(v ?? 'unknown')} |`);
  out.push('');
  out.push('## Checks');
  out.push('');
  out.push('| Status | Check | Details |');
  out.push('| --- | --- | --- |');
  for (const i of items) out.push(`| ${i.status} | ${cell(`${i.id} ${i.title}`)} | ${cell(i.details.join('; '))} |`);
  out.push('');
  const failed = items.filter((i) => i.status === STATUS.FAIL);
  if (failed.length) {
    out.push('## Failures in detail');
    out.push('');
    for (const i of failed) {
      out.push(`### ${i.id} ${i.title}`);
      out.push('');
      out.push('```text');
      out.push(...i.details);
      out.push('```');
      out.push('');
    }
  }
  const notRun = items.filter((i) => i.status === STATUS.NOT_RUN);
  if (notRun.length) {
    out.push('## Not run');
    out.push('');
    for (const i of notRun) out.push(`* ${i.id} ${i.title}: ${i.details.join('; ') || 'no reason recorded'}`);
    out.push('');
  }
  out.push('## What this does NOT prove');
  out.push('');
  for (const line of NOT_PROVEN) out.push(`* ${line}`);
  out.push('');
  out.push('The human checks that remain are listed in docs/WINDOWS_VERIFICATION.md (R1, R3, R4, R5, R7 and step 11 on a real PC).');
  out.push('');
  return out.join('\n');
}

/** `hooks.plan` returns the settings file text in `after`. Returns { Event: command } for the events asked for. */
export function extractHookCommands(afterText, events) {
  const settings = JSON.parse(afterText);
  const found = {};
  for (const event of events) {
    const groups = settings?.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of group?.hooks ?? []) {
        if (hook?.type === 'command' && typeof hook.command === 'string' && /capture\.mjs/.test(hook.command)) {
          found[event] = { command: hook.command, shell: hook.shell ?? null, timeout: hook.timeout ?? null };
        }
      }
    }
  }
  return found;
}

/** The value of `--spool "<dir>"` in a Windows hook command, or null. */
export function spoolFromCommand(command) {
  const quoted = /--spool\s+"([^"]+)"/.exec(command);
  if (quoted) return quoted[1];
  const bare = /--spool\s+(\S+)/.exec(command);
  return bare ? bare[1] : null;
}

/** The executable of `& "<exe>" ...` in a Windows hook command, or null. */
export function exeFromCommand(command) {
  const m = /&\s+"([^"]+)"/.exec(command);
  return m ? m[1] : null;
}

/** The same command without the trailing `| Write-Output` (the control for the W-11 measurement). */
export function stripWriteOutput(command) {
  return command.replace(/\s*\|\s*Write-Output\s*$/, '');
}

/** What `powershell.exe -EncodedCommand` wants: base64 of the UTF-16LE text. */
export function encodePsCommand(command) {
  return Buffer.from(command, 'utf16le').toString('base64');
}

/** Windows paths compare case-insensitively and with either slash. */
export function samePath(a, b) {
  const n = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return n(a) === n(b);
}

/** Paths (dot notation) where two JSON-like values differ. Empty when they are identical. */
export function deepDiff(a, b, prefix = '') {
  if (Object.is(a, b)) return [];
  const isObj = (v) => v !== null && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    return [`${prefix || '(root)'}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
  }
  const diffs = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diffs.push(...deepDiff(a[key], b[key], prefix ? `${prefix}.${key}` : key));
  }
  return diffs;
}

/** True when packages/shared declares a per-project `chatgptUrl` in the window's remembered state. */
export function hasChatgptUrlField(sourceText) {
  return /\bchatgptUrl\b/.test(sourceText);
}

/** The requestedExecutionLevel of an executable's embedded manifest (it is stored as plain XML), or null. */
export function manifestExecutionLevel(buffer) {
  const text = buffer.toString('latin1');
  const m = /requestedExecutionLevel[^>]*?level\s*=\s*["']([A-Za-z]+)["']/.exec(text);
  return m ? m[1] : null;
}

/** Files with one of `names` (case-insensitive) below `root`, to `maxDepth` levels. */
export function findByName(root, names, maxDepth = 12) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const hits = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) walk(full, depth + 1); } else if (wanted.has(e.name.toLowerCase())) hits.push(full);
    }
  };
  walk(root, 0);
  return hits;
}

/** *.json files below `dirs` (to `maxDepth`) whose text contains `needle`. */
export function findFilesContaining(dirs, needle, maxDepth = 3) {
  const hits = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) walk(full, depth + 1); continue; }
      if (!e.name.endsWith('.json')) continue;
      try { if (fs.readFileSync(full, 'utf8').includes(needle)) hits.push(full); } catch { /* being renamed */ }
    }
  };
  for (const d of dirs) walk(d, 0);
  return hits;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `fn` until it returns a truthy value or `timeoutMs` passes. Returns the value or null. */
export async function pollUntil(fn, { timeoutMs, intervalMs = 500 }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}
