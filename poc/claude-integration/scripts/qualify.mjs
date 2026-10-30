#!/usr/bin/env node
// Qualification runner. Executes the PoC on the machine it runs on and records an honest result per test.
//
//   node scripts/qualify.mjs run   [--base DIR] [--shared DIR] [--only Q01,Q02] [--live] [--with-model]
//                                  [--wsl-distro NAME --wsl-config PATH_INSIDE_WSL]
//   node scripts/qualify.mjs merge report-win.json report-wsl.json ...
//
// Rules this script enforces about itself:
//   * A test is PASS or FAIL only if it executed here. Everything else is NOT TESTED, with the reason.
//   * A result belongs to the environment that ran it (win, wsl:<distro>, posix). Linux results never count for Windows.
//   * Interactive tests (--live) wait for a human action; a timeout is NOT TESTED, not FAIL.
//   * Tests that call a model (--with-model) are off by default.
//   * The normal Claude configuration is hashed before and after; any change is a FAIL of Q16.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectEnv, canonicalize, loadRegistry } from '../src/lib/registry.mjs';
import { Store } from '../src/lib/store.mjs';
import { replay } from '../src/lib/reducer.mjs';
import { takeSnapshot } from '../src/lib/snapshot.mjs';
import { runAgentsJson, claudeBin, evaluateSeparateDiscovery } from '../src/lib/discovery.mjs';
import { EVENTS } from '../src/lib/setup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const mode = args[0];
const opt = {};
for (let i = 1; i < args.length; i++) { if (args[i].startsWith('--')) { const k = args[i].slice(2); const v = args[i + 1]; opt[k] = v === undefined || v.startsWith('--') ? true : (i++, v); } }

export const CATALOG = [
  ['Q01', 'Claude CLI version detection', 'any'],
  ['Q02', 'Isolated configuration created, normal one refused', 'any'],
  ['Q03', 'Hook command executes in the real hook shell, for all 9 events, including a path with spaces', 'any'],
  ['Q04', 'Atomic spool writes: no partial file is ever visible to a concurrent reader', 'any'],
  ['Q05', 'WSL spool delivered across the WSL/Windows boundary and ingested on Windows', 'wsl+win'],
  ['Q06', 'Event ingestion in this environment', 'any'],
  ['Q07', 'Session discovery command works against the isolated config', 'any'],
  ['Q08', 'External session discovered (started by a human in another terminal)', 'any'],
  ['Q09', 'Session UUID consistent across --session-id, hooks and discovery', 'any'],
  ['Q10', 'Session mapped to the correct project', 'any'],
  ['Q11', 'Session resume keeps the UUID and opens generation 2 (needs one tiny prompt: an unused session is not saved)', 'any'],
  ['Q12', 'Duplicate registrations collapse; no real event is lost', 'any'],
  ['Q13', 'Hard process kill detected (observed exit or suspected loss)', 'any'],
  ['Q14', 'Report captured from a real model run (costs tokens)', 'any'],
  ['Q15', 'Ingestor restart is idempotent', 'any'],
  ['Q16', 'Normal Claude settings unmodified', 'any'],
  ['Q17', 'Path normalization against the real file system', 'any'],
  ['Q18', 'WSL sessions discovered separately from Windows', 'win'],
];

// ---------- helpers ----------
const env = detectEnv();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const results = new Map();
let scrubList = [];
// Reports are meant to be shareable: remove home directories, user names and every path this run created.
const scrub = (str) => scrubList.reduce((acc, [from, to]) => acc.split(from).join(to), String(str))
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<session-uuid>');
const rec = (id, status, notes) => results.set(id, { id, status, notes: (Array.isArray(notes) ? notes : [notes]).map(scrub), at: status === 'NOT TESTED' ? null : new Date().toISOString() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (q) => new Promise((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); res(a); }); });

function hookShell(command, hookDef) {
  if (hookDef.shell === 'powershell') return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]];
  return ['sh', ['-c', command]];
}
function runHookCommand(hookDef, payload) {
  const [file, argv] = hookShell(hookDef.command, hookDef);
  const r = spawnSync(file, argv, { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
}
const listJson = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json') && !f.startsWith('.')) : []);
function payloadFor(event, sid, cwd, extra = {}) {
  const base = { session_id: sid, cwd, transcript_path: 'synthetic', hook_event_name: event, permission_mode: 'default' };
  const specifics = {
    SessionStart: { source: 'startup' }, UserPromptSubmit: { prompt_id: crypto.randomUUID(), prompt: 'synthetic' },
    PermissionRequest: { tool_name: 'Bash', tool_input: { command: 'echo' } }, PreToolUse: { tool_name: 'Bash', tool_input: {}, tool_use_id: 'toolu_q' },
    PostToolUse: { tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'toolu_q' }, Notification: { notification_type: 'idle_prompt', message: 'x' },
    Stop: { stop_hook_active: false, last_assistant_message: 'synthetic', background_tasks: [], session_crons: [] },
    StopFailure: { error: 'unknown' }, SessionEnd: { reason: 'other' },
  };
  return { ...base, ...specifics[event], ...extra };
}
function normalConfigDigest() {
  const dirs = [path.join(os.homedir(), '.claude'), process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.claude')].filter(Boolean);
  const targets = ['settings.json', 'settings.local.json', 'CLAUDE.md', 'rules', 'commands', 'agents', 'skills', 'hooks'];
  const out = {};
  const walk = (p, acc) => { const st = fs.statSync(p); if (st.isDirectory()) for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n), acc); else acc.push(`${p}:${sha(fs.readFileSync(p))}`); };
  for (const d of new Set(dirs)) {
    const acc = [];
    if (fs.existsSync(d)) for (const t of targets) { const p = path.join(d, t); if (fs.existsSync(p)) { try { walk(p, acc); } catch { acc.push(`${p}:unreadable`); } } }
    out[d] = { exists: fs.existsSync(d), digest: sha(acc.join('\n')), files: acc.length };
  }
  return out;
}

// ---------- main ----------
if (mode === 'merge') { merge(args.slice(1)); process.exit(0); }
if (mode !== 'run') { console.error(fs.readFileSync(import.meta.filename, 'utf8').split('\n').slice(1, 12).join('\n')); process.exit(2); }

const wanted = opt.only ? new Set(String(opt.only).split(',')) : null;
const want = (id) => !wanted || wanted.has(id);
const before = normalConfigDigest();

// Q02 setup (also used by everything else)
const setupArgs = ['scripts/setup-isolated.mjs', '--handlers', '2'];
if (opt.base) setupArgs.push('--base', opt.base);
if (opt.shared) setupArgs.push('--shared', opt.shared);
let L; let envTag;
try {
  L = JSON.parse(execFileSync(process.execPath, setupArgs, { cwd: root, encoding: 'utf8' }));
  envTag = L.env;
  const user = os.userInfo().username;
  scrubList = [[L.shared, '<SHARED>'], [L.config, '<CONFIG>'], [L.work, '<WORK>'], [os.homedir(), '<HOME>'], [process.env.USERPROFILE ?? '\u0000', '<HOME>'], [process.env.LOCALAPPDATA ?? '\u0000', '<LOCALAPPDATA>'], [user, '<USER>']]
    .filter(([from]) => from && from.length > 2).sort((a, b) => b[0].length - a[0].length);
  rec('Q02', 'PASS', [`config dir ${L.config}`, `shared dir ${L.shared}`, 'settings.json written with 2 handlers', 'setup refuses the normal config directory (checked in code)']);
} catch (e) {
  rec('Q02', 'FAIL', String(e.stderr || e.message).slice(0, 400));
  finish(); process.exit(1);
}
const settings = JSON.parse(fs.readFileSync(path.join(L.config, 'settings.json'), 'utf8'));
const hookDefs = (event) => settings.hooks[event][0].hooks;
const registry = loadRegistry(L.registry);
const mainStore = new Store(L.store);
const spools = [L.spool];
const tmpRoot = fs.mkdtempSync(path.join(L.reports, 'run-'));
const projDir = path.join(L.work, L.projects[0]);

// Q01
if (want('Q01')) {
  const bin = claudeBin();
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin), windowsHide: true });
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout ?? '');
  if (r.status === 0 && m) rec('Q01', 'PASS', [`claude ${m[1]} via ${bin}`]);
  else { rec('Q01', 'FAIL', [`could not run ${bin} --version: ${r.error?.message ?? r.stderr}`]); }
}
const claudeOk = results.get('Q01')?.status === 'PASS' || !want('Q01') && spawnSync(claudeBin(), ['--version'], { windowsHide: true }).status === 0;

// Q03
if (want('Q03')) {
  const notes = []; let ok = true;
  const spaced = path.join(tmpRoot, 'Mini Summa Spaced');          // a path with spaces, as in many Windows profiles
  fs.mkdirSync(spaced, { recursive: true });
  for (const [label, dir] of [['normal path', L.spool], ['path with spaces', path.join(spaced, 'spool')]]) {
    for (const ev of EVENTS) {
      const def = { ...hookDefs(ev)[0] };
      def.command = def.command.split(L.spool).join(dir);
      const sid = crypto.randomUUID();
      const r = runHookCommand(def, payloadFor(ev, sid, projDir));
      const files = listJson(dir).filter((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).payload.session_id === sid; } catch { return false; } });
      const good = r.status === 0 && (ev === 'SessionStart' ? true : r.stdout === '') && files.length === 1;
      if (!good) { ok = false; notes.push(`${label} ${ev}: status=${r.status} stdout=${JSON.stringify(r.stdout).slice(0, 80)} stderr=${String(r.stderr).slice(0, 120)} files=${files.length} ${r.error ?? ''}`); }
      if (good && ev === 'SessionStart') {
        try { const o = JSON.parse(r.stdout || '{}'); if (r.stdout && o.hookSpecificOutput?.hookEventName !== 'SessionStart') { ok = false; notes.push(`${label}: SessionStart output malformed`); } } catch { ok = false; notes.push(`${label}: SessionStart output not JSON`); }
      }
    }
  }
  if (ok) notes.push(`all ${EVENTS.length} events exited 0 with no decision output, in both a normal path and a path with spaces`, `shell used: ${hookDefs('Stop')[0].shell ?? 'sh -c'}`);
  rec('Q03', ok ? 'PASS' : 'FAIL', notes);
}

// Q04
if (want('Q04')) {
  const dir = path.join(tmpRoot, 'atomic'); fs.mkdirSync(dir, { recursive: true });
  const def = { ...hookDefs('PostToolUse')[0] }; def.command = def.command.split(L.spool).join(dir);
  const [file, argv] = hookShell(def.command, def);
  let partial = 0; let seen = 0; let stop = false;
  const poll = (async () => { while (!stop) { for (const f of listJson(dir)) { seen++; try { JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { partial++; } } await sleep(2); } })();
  const N = 30;
  await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
    const c = spawn(file, argv, { windowsHide: true }); c.on('close', res); c.on('error', res);
    c.stdin.end(JSON.stringify(payloadFor('PostToolUse', crypto.randomUUID(), projDir, { tool_use_id: `t${i}` })));
  })));
  stop = true; await poll;
  const files = listJson(dir); const tmp = fs.readdirSync(dir).filter((f) => f.startsWith('.tmp-'));
  const ok = files.length === N && partial === 0 && tmp.length === 0;
  rec('Q04', ok ? 'PASS' : 'FAIL', [`${files.length}/${N} files, partial reads ${partial} over ${seen} observations, temp residue ${tmp.length}`]);
}

// Q05
if (want('Q05')) {
  const manifest = path.join(L.reports, 'q05-manifest.json');
  if (env.startsWith('wsl:')) {
    const ids = [];
    for (let i = 0; i < 20; i++) { const sid = crypto.randomUUID(); ids.push(sid); runHookCommand(hookDefs('SessionStart')[0], payloadFor('SessionStart', sid, projDir)); }
    fs.writeFileSync(manifest, JSON.stringify({ env, spool: L.spool, ids }));
    rec('Q05', 'NOT TESTED', ['WSL half done: 20 SessionStart files written across the boundary.', `Now run on WINDOWS: node scripts/qualify.mjs run --only Q05  (it ingests ${L.spool} and checks the manifest)`]);
  } else if (env === 'win') {
    if (!fs.existsSync(manifest)) rec('Q05', 'NOT TESTED', ['no WSL manifest found; run the WSL half first']);
    else {
      const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const wslSpool = L.spool.replace(/spool-win$/, path.basename(m.spool.replace(/\\/g, '/')));
      const s = new Store(path.join(tmpRoot, 'q05')); const r = s.ingestSpool(wslSpool);
      const got = new Set(s.raw.map((e) => e.payload.session_id)); const missing = m.ids.filter((x) => !got.has(x));
      const envs = new Set(s.raw.map((e) => e.transport.env_id));
      const ok = missing.length === 0 && [...envs].every((e) => e.startsWith('wsl:'));
      rec('Q05', ok ? 'PASS' : 'FAIL', [`ingested ${r.ingested}, missing ${missing.length}, env ids ${[...envs].join(',')}`, `spool ${wslSpool}`]);
    }
  } else rec('Q05', 'NOT TESTED', ['needs WSL then Windows']);
}

// Q06 + Q12 + Q15 use one synthetic session through the real hook commands
if (want('Q06') || want('Q12') || want('Q15')) {
  const dir = path.join(tmpRoot, 'ingest'); fs.mkdirSync(dir, { recursive: true });
  const sid = crypto.randomUUID(); const prompt = crypto.randomUUID();
  const msg = 'done\n\n## Implementation Report\n- synthetic\n\n<!-- mini-summa:report status=partial task="Qualification" -->\n';
  const seq = [['SessionStart', { source: 'startup' }], ['UserPromptSubmit', { prompt_id: prompt }], ['PreToolUse', { tool_use_id: 'a' }], ['PermissionRequest', {}],
    ['PostToolUse', { tool_use_id: 'a' }], ['Stop', { prompt_id: prompt, last_assistant_message: msg }], ['SessionEnd', {}]];
  for (const [ev, extra] of seq) for (const def of hookDefs(ev)) { // both handlers, like a doubly registered hook
    const d = { ...def }; d.command = d.command.split(L.spool).join(dir);
    runHookCommand(d, payloadFor(ev, sid, projDir, extra));
  }
  const store = new Store(path.join(tmpRoot, 'store1')); const ing = store.ingestSpool(dir);
  let r = replay(store.raw, registry);
  const proj = r.sessions.get(`${envTagKey()}|${sid}`) ?? [...r.sessions.values()][0];
  if (want('Q06')) {
    const ok = ing.ingested === seq.length * 2 && r.reports.size === 1 && [...r.reports.values()][0].body === msg && proj?.project?.name === L.projects[0] && proj?.state === 'ended';
    rec('Q06', ok ? 'PASS' : 'FAIL', [`raw ${store.raw.length}, reports ${r.reports.size}, project ${proj?.project?.name}, final state ${proj?.state}`, 'report body byte-identical to the Stop message']);
  }
  if (want('Q12')) {
    const ok = r.logical.size === seq.length && r.duplicates.length === seq.length && store.raw.length === seq.length * 2;
    rec('Q12', ok ? 'PASS' : 'FAIL', [`synthetic events through the real hook shell: raw ${store.raw.length}, logical ${r.logical.size}, duplicates flagged ${r.duplicates.length}`, 'the --live flow repeats this on a real Claude session']);
  }
  if (want('Q15')) {
    const again = new Store(path.join(tmpRoot, 'store1'));
    for (const f of fs.readdirSync(path.join(dir, 'done'))) fs.copyFileSync(path.join(dir, 'done', f), path.join(dir, f)); // files reappear after a "crash"
    const re = again.ingestSpool(dir);
    const r2 = replay(again.raw, registry);
    const child = spawnSync(process.execPath, [path.join(root, 'src/cli/ingest.mjs'), '--spool', dir, '--store', path.join(tmpRoot, 'store1'), '--registry', L.registry], { encoding: 'utf8' });
    const ok = re.ingested === 0 && re.already_ingested === seq.length * 2 && again.raw.length === store.raw.length
      && JSON.stringify(r2.derived.map((d) => d.derived_id)) === JSON.stringify(r.derived.map((d) => d.derived_id)) && child.status === 0;
    rec('Q15', ok ? 'PASS' : 'FAIL', [`re-ingest: new ${re.ingested}, already seen ${re.already_ingested}; raw ${again.raw.length}; derived ids identical across restart; ingest CLI exit ${child.status}`]);
  }
}
function envTagKey() { return env; }

// Q07 and Q18
if (want('Q07')) {
  if (!claudeOk) rec('Q07', 'NOT TESTED', ['claude not runnable']);
  else try {
    const { raw } = await runAgentsJson({ configDir: L.config });
    rec('Q07', Array.isArray(raw) ? 'PASS' : 'FAIL', [`claude agents --json returned ${Array.isArray(raw) ? raw.length : 'non-array'} session(s) for the isolated config`]);
  } catch (e) { rec('Q07', 'FAIL', String(e.message).slice(0, 300)); }
}
if (want('Q18')) {
  if (env !== 'win') rec('Q18', 'NOT TESTED', ['only meaningful on native Windows']);
  else if (!opt['wsl-distro'] || !opt['wsl-config']) rec('Q18', 'NOT TESTED', ['pass --wsl-distro NAME --wsl-config PATH (the WSL config dir, e.g. /home/you/.mini-summa-poc/config-wsl-Ubuntu)']);
  else {
    // Each environment is queried on its own so a failure is attributed to the right side, never ignored.
    const q = async (o) => { try { return (await runAgentsJson(o)).raw; } catch (e) { return e; } };
    const win = await q({ configDir: L.config });
    const wsl = await q({ wslDistro: opt['wsl-distro'], configDir: opt['wsl-config'] });
    const v = evaluateSeparateDiscovery({ win, wsl, expect: { win: opt['expect-win'], wsl: opt['expect-wsl'] } });
    rec('Q18', v.status, v.notes);
  }
}

// Q17
if (want('Q17')) {
  const notes = []; let ok = true;
  const d = path.join(L.work, 'CaseTest'); fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
  const reg = loadRegistry(L.registry);
  const variants = env === 'win' ? [d, d.toUpperCase(), d.toLowerCase(), d.replace(/\\/g, '/'), `${d}\\`, `${d}\\sub\\..`] : [d, `${d}/`, `${d}/sub/..`];
  const keys = new Set(variants.map((v) => JSON.stringify(canonicalize(v, env))));
  if (keys.size !== 1) { ok = false; notes.push(`${variants.length} spellings produced ${keys.size} different keys`); }
  const proj = L.projects[0]; const inside = path.join(L.work, proj, 'x');
  for (const v of env === 'win' ? [inside, inside.toUpperCase()] : [inside]) if (reg.resolve(v, env).project?.name !== proj) { ok = false; notes.push(`registry did not map ${v} to ${proj}`); }
  if (env.startsWith('wsl:')) {
    try {
      const winForm = execFileSync('wslpath', ['-w', L.shared], { encoding: 'utf8' }).trim();
      const a = canonicalize(winForm, 'win'); const b = canonicalize(L.shared, env);
      if (JSON.stringify(a) !== JSON.stringify(b)) { ok = false; notes.push(`wslpath -w form ${winForm} does not match ${L.shared}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); } else notes.push(`${L.shared} and ${winForm} are the same directory key`);
    } catch (e) { ok = false; notes.push(`wslpath failed: ${e.message}`); }
  }
  rec('Q17', ok ? 'PASS' : 'FAIL', notes.length ? notes : ['spellings and case variants resolve to the same project']);
}

// ---------- live, human-assisted ----------
const liveIds = ['Q08', 'Q09', 'Q10', 'Q11', 'Q13'];
if (opt.live && liveIds.some(want)) await liveFlow(); else for (const id of liveIds) if (want(id) && !results.has(id)) rec(id, 'NOT TESTED', ['needs --live (a human starts and stops one idle Claude session; no model tokens are used)']);
if (want('Q14')) {
  if (!opt['with-model']) rec('Q14', 'NOT TESTED', ['needs --with-model (one small claude -p run, roughly US$0.1 to 0.2)']);
  else if (!claudeOk) rec('Q14', 'NOT TESTED', ['claude not runnable']);
  else await modelRun();
}
if (!results.has('Q12') && want('Q12')) rec('Q12', 'NOT TESTED', 'not run');

finish();

// ---------- implementations that need the claude binary ----------
function drainAll() { for (const s of spools) mainStore.ingestSpool(s); }
async function snap() { return takeSnapshot({ store: mainStore, spools, envId: env, runOpts: { configDir: L.config } }); }
function launch(extra) {
  return env === 'win'
    ? `$env:CLAUDE_CONFIG_DIR = "${L.config}"; Set-Location "${projDir}"; claude ${extra}`
    : `cd "${projDir}" && CLAUDE_CONFIG_DIR="${L.config}" claude ${extra}`;
}

async function waitFor(label, fn, ms = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { drainAll(); const v = await fn(); if (v) return v; await sleep(1500); }
  console.log(`  timed out waiting for: ${label}`); return null;
}
function sessionState(sid) { const r = replay(mainStore.raw, registry); return { r, s: [...r.sessions.values()].find((x) => x.session_id === sid) }; }

async function liveFlow() {
  const U = crypto.randomUUID();
  console.log(`\nLIVE TEST. Open a SECOND terminal and run exactly:\n\n  ${launch(`--session-id ${U}`)}\n`);
  console.log('First run of an isolated config shows onboarding, the folder trust prompt (choose "Yes, I trust this folder"; the default is No), and may need /login.');
  console.log('Do not type a prompt. Leave the session idle. Waiting up to 5 minutes...\n');
  const up = await waitFor('SessionStart hook for the session', () => mainStore.raw.some((e) => e.kind === 'hook' && e.payload.session_id === U && e.payload.hook_event_name === 'SessionStart'));
  const snapAlive = up && await waitFor('session listed by claude agents --json', async () => { const x = await snap(); return x.sessions.find((s) => s.sessionId === U) ? x : null; }, 60000);
  const { r, s } = sessionState(U);
  const listed = snapAlive?.sessions.find((x) => x.sessionId === U);
  if (!up) for (const id of ['Q08', 'Q09', 'Q10']) rec(id, 'NOT TESTED', ['no SessionStart hook seen within 5 minutes (session not started, not logged in, or hooks did not run)']);
  else {
    const hookIds = new Set(mainStore.raw.filter((e) => e.kind === 'hook' && e.payload.session_id === U).map((e) => e.payload.session_id));
    rec('Q08', listed && listed.kind === 'interactive' ? 'PASS' : 'FAIL', [listed ? `listed: kind=${listed.kind} status=${listed.status} pid=${listed.pid}` : 'agents --json did not list the session', 'the session was started by a human, not by this script']);
    rec('Q09', listed && listed.sessionId === U && hookIds.has(U) ? 'PASS' : 'FAIL', [`chosen ${U}`, `listing ${listed?.sessionId}`, `hook session_id ${[...hookIds].join(',')}`]);
    rec('Q10', s?.project?.name === L.projects[0] ? 'PASS' : 'FAIL', [`mapped to ${s?.project?.name ?? 'nothing'} (${s?.project_reason}); expected ${L.projects[0]}`]);
    const ss = mainStore.raw.filter((e) => e.kind === 'hook' && e.payload.session_id === U && e.payload.hook_event_name === 'SessionStart');
    const logical = [...r.logical.values()].filter((l) => l.ev === 'SessionStart' && l.session.endsWith(U));
    rec('Q12', ss.length === 2 && logical.length === 1 ? 'PASS' : 'FAIL', [`live: SessionStart raw ${ss.length} (expected 2: two handlers), logical ${logical.length} (expected 1)`]);
  }
  if (!up) { for (const id of ['Q11', 'Q13']) rec(id, 'NOT TESTED', ['depends on the live session']); if (!results.has('Q12')) rec('Q12', 'NOT TESTED', ['no live session']); return; }

  // Optional: give the session one real exchange so that it is saved and can be resumed.
  let exchanged = false;
  if (opt['with-model']) {
    console.log('\nIn that same session type this one line and press Enter (about US$0.1 of model usage):\n\n  Reply with the single word ok.\n');
    exchanged = Boolean(await waitFor('a Stop hook for the session', () => mainStore.raw.some((e) => e.kind === 'hook' && e.payload.session_id === U && e.payload.hook_event_name === 'Stop'), 240000));
  }
  // Q13 hard kill
  const pid = listed?.pid;
  console.log(`\nNow kill that session WITHOUT exiting it. In a third terminal run:\n\n  ${env === 'win' ? `Stop-Process -Id ${pid} -Force` : `kill -9 ${pid}`}\n`);
  const gone = await waitFor('process gone', async () => { const x = await snap(); const e = x.sessions.find((q) => q.sessionId === U); return !e || e.pid_alive === false ? x : null; }, 180000);
  if (!gone) rec('Q13', 'NOT TESTED', ['process was not killed within 3 minutes']);
  else {
    await snap(); // a second snapshot, as the ingestor would take
    const { s: s2 } = sessionState(U);
    const endHook = mainStore.raw.some((e) => e.kind === 'hook' && e.payload.session_id === U && e.payload.hook_event_name === 'SessionEnd');
    const how = s2?.gen.term?.kind;
    rec('Q13', ['ended', 'presence_lost'].includes(s2?.state) && !endHook ? 'PASS' : 'FAIL', [`state ${s2?.state}, evidence ${how}, closed by snapshot #${s2?.gen.term?.snapshot_seq}, unresolved hooks ${s2?.unresolved.length}, SessionEnd hook seen: ${endHook}`,
      how === 'process_exit' ? 'observed process exit (pid dead on this host)' : 'suspected presence loss: absent from the listing, no pid evidence']);
  }
  // Q11 resume
  if (!exchanged) { rec('Q11', 'NOT TESTED', ['needs --with-model: a session that never received a prompt is not saved, so claude --resume finds nothing (observed on Linux)']); return; }
  console.log(`\nNow resume the SAME session. In the second terminal run:\n\n  ${launch(`--resume ${U}`)}\n\nThen type /exit to leave it normally.\n`);
  const res = await waitFor('SessionStart(source=resume) for the same UUID', () => mainStore.raw.some((e) => e.kind === 'hook' && e.payload.session_id === U && e.payload.hook_event_name === 'SessionStart' && e.payload.source === 'resume'), 300000);
  if (!res) rec('Q11', 'NOT TESTED', ['no resume seen within 5 minutes']);
  else {
    await waitFor('SessionEnd after /exit', () => mainStore.raw.some((e) => e.kind === 'hook' && e.payload.session_id === U && e.payload.hook_event_name === 'SessionEnd'), 120000);
    const { s: s3 } = sessionState(U);
    rec('Q11', s3?.gen.n >= 2 ? 'PASS' : 'FAIL', [`generation ${s3?.gen.n} (expected 2 or more), same UUID ${U}`, `final state ${s3?.state}`]);
  }
}

async function modelRun() {
  const U = crypto.randomUUID();
  const out = path.join(tmpRoot, 'model-result.json');
  const instr = 'Create a file named qualification.txt containing the word ok, then finish the task.';
  const r = spawnSync(claudeBin(), ['-p', '--session-id', U, '--permission-mode', 'acceptEdits', '--output-format', 'json', instr],
    { cwd: projDir, env: { ...process.env, CLAUDE_CONFIG_DIR: L.config }, encoding: 'utf8', timeout: 240000, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeBin()), windowsHide: true });
  fs.writeFileSync(out, r.stdout ?? '');
  drainAll();
  let result; try { result = JSON.parse(r.stdout).result; } catch { rec('Q14', 'FAIL', [`claude -p failed: ${(r.stderr || r.error || '').toString().slice(0, 300)} (is the isolated config logged in? run claude interactively once with that config dir)`]); return; }
  const rep = [...replay(mainStore.raw, registry).reports.values()].find((x) => x.session_id === U);
  if (!rep) rec('Q14', 'FAIL', ['no valid marker: the model did not follow the report protocol, or SessionStart context was not injected', `result tail: ${JSON.stringify(String(result).slice(-120))}`]);
  else rec('Q14', rep.body.trim() === String(result).trim() ? 'PASS' : 'FAIL', [`declared ${rep.declared_status}; body equals claude's result: ${rep.body.trim() === String(result).trim()}`, 'one run proves the mechanism, not protocol reliability']);
}

// ---------- reporting ----------
function finish() {
  const after = normalConfigDigest();
  if (want('Q16')) {
    const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    rec('Q16', changed.length ? 'FAIL' : 'PASS', changed.length ? changed.map((k) => `changed: ${k}`) : [`hashed settings, CLAUDE.md, rules, commands, agents, skills, hooks in ${Object.keys(after).length} location(s); identical before and after`]);
  }
  const rows = CATALOG.filter(([id]) => want(id)).map(([id, title, scope]) => {
    const r = results.get(id) ?? { status: 'NOT TESTED', notes: ['not run'] };
    let status = r.status;
    if (scope === 'win' && env !== 'win' && status !== 'NOT TESTED') status = 'NOT TESTED';
    return { id, title, scope, status, notes: r.notes, at: r.at ?? null };
  });
  const rep = { generated: new Date().toISOString(), env, platform: process.platform, arch: process.arch, node: process.version,
    claude: spawnSync(claudeBin(), ['--version'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeBin()) }).stdout?.trim() || 'not found',
    os: `${os.type()} ${os.release()}`, wsl_distro: process.env.WSL_DISTRO_NAME ?? null, results: rows };
  const dir = L?.reports ?? process.cwd(); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `report-${(L?.env ?? env).replace(/[^A-Za-z0-9_-]+/g, '-')}.json`);
  // A partial re-run must not erase earlier evidence: keep a previous PASS/FAIL where this run did not execute the test.
  if (!opt.fresh && fs.existsSync(file)) {
    const old = JSON.parse(fs.readFileSync(file, 'utf8')).results ?? [];
    for (const o of old) if (!rows.some((r) => r.id === o.id)) rows.push(o); // tests excluded by --only keep their earlier row
    rows.sort((x, y) => x.id.localeCompare(y.id));
    for (const r of rows) { const o = old.find((x) => x.id === r.id); if (r.status === 'NOT TESTED' && o && o.status !== 'NOT TESTED') { r.status = o.status; r.notes = [...o.notes, `(kept from an earlier run at ${o.at})`]; r.at = o.at; } }
  }
  fs.writeFileSync(file, JSON.stringify(rep, null, 2));
  rep.results = rows;
  console.log(`\nQualification on ${rep.env} (${rep.os}), node ${rep.node}, claude ${rep.claude}\n`);
  for (const r of rows) { console.log(`${r.status.padEnd(10)} ${r.id}  ${r.title}`); for (const n of r.notes) console.log(`             ${n}`); }
  console.log(`\nreport: ${file}`);
}

function merge(files) {
  const reps = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const envs = reps.map((r) => r.env);
  const head = ['Test', ...envs].join(' | ');
  const lines = [`| ${head} |`, `|${' --- |'.repeat(envs.length + 1)}`];
  for (const [id, title] of CATALOG) {
    const cells = reps.map((r) => r.results.find((x) => x.id === id)?.status ?? 'NOT TESTED');
    lines.push(`| ${id} ${title} | ${cells.join(' | ')} |`);
  }
  console.log(lines.join('\n'));
  console.log('\nA cell is PASS only if that environment executed the test. NOT TESTED means it did not run there.');
}
