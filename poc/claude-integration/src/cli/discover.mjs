#!/usr/bin/env node
// Read-only discovery: runs `claude agents --json` and maps results to registered projects.
// usage: node src/cli/discover.mjs [--config-dir DIR] [--wsl-distro NAME] [--cwd PATH] [--all] [--registry FILE]
//          [--store DIR --spool DIR [--spool DIR ...] --record]
//   --wsl-distro runs the query inside that WSL distribution (WSL sessions only; pid liveness is then unknown)
//   --record appends a snapshot to the raw log after draining the spool (ordering barrier)
import { runAgentsJson, normalizeAgents, validateAgents, pidAlive } from '../lib/discovery.mjs';
import { loadRegistry, createRegistry, detectEnv } from '../lib/registry.mjs';
import { Store } from '../lib/store.mjs';
import { takeSnapshot } from '../lib/snapshot.mjs';

const a = { spool: [] };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k === '--all' || k === '--record') a[k.slice(2)] = true;
  else if (k === '--spool') a.spool.push(process.argv[++i]);
  else a[k.slice(2)] = process.argv[++i];
}
const envId = a['wsl-distro'] ? `wsl:${a['wsl-distro']}` : detectEnv();
const registry = a.registry ? loadRegistry(a.registry) : createRegistry({ projects: [] });
const runOpts = { configDir: a['config-dir'], all: a.all, wslDistro: a['wsl-distro'], cwd: a.cwd };
const remote = Boolean(a['wsl-distro']);
let raw; let sessions; let cmd;
if (a.record) { // the snapshot path owns the single claude call so the barrier is captured before it
  if (!a.store) { console.error('--record needs --store'); process.exit(2); }
  const r = await takeSnapshot({ store: new Store(a.store), spools: a.spool, envId, runOpts, scopeCwd: a.cwd ?? null, remote });
  raw = r.raw; sessions = r.sessions; cmd = 'claude agents --json (recorded)';
  console.error(`recorded snapshot seq=${r.entry.seq} barrier=${JSON.stringify(r.entry.payload.barrier)}`);
} else {
  const r = await runAgentsJson(runOpts);
  raw = r.raw; cmd = `${r.file} ${r.args.join(' ')}`;
  sessions = normalizeAgents(raw).map((s) => ({ ...s, pid_alive: pidAlive(s.pid, { remote }) }));
}
console.log(JSON.stringify({
  command: cmd, env_id: envId, config_dir: a['config-dir'] ?? '(inherited environment, read-only)',
  validation: validateAgents(raw),
  sessions: sessions.map((s) => ({ ...s, project: registry.resolve(s.cwd, envId).project?.name ?? null, project_reason: registry.resolve(s.cwd, envId).reason })),
}, null, 2));
