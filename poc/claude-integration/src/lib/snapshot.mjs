import { runAgentsJson, normalizeAgents, pidAlive } from './discovery.mjs';

// Take a discovery snapshot and append it to the raw log with an explicit ordering barrier.
//
// Barrier: record which hook files are already waiting in the spool(s) BEFORE asking claude. Those files
// were written before this snapshot began, so they are causally earlier. Ingest exactly those first, then
// append the snapshot. Hook files that appear afterwards are ingested after it. Log order is therefore
// causal for hooks versus snapshots, with no clock comparison between different sources.
export async function takeSnapshot({ store, spools = [], envId, run = runAgentsJson, runOpts = {}, scopeCwd = null, remote = false }) {
  const before = spools.map((dir) => ({ dir, names: new Set(store.pendingSpool(dir)) }));
  const { raw } = await run({ ...runOpts, cwd: scopeCwd ?? undefined });
  let drained = 0;
  for (const b of before) drained += store.ingestSpool(b.dir, { only: b.names }).ingested;
  const sessions = normalizeAgents(raw).map(({ _extra_keys, ...x }) => ({ ...x, pid_alive: pidAlive(x.pid, { remote }) }));
  const entry = store.appendRaw({
    kind: 'discovery',
    transport: { received_at: new Date().toISOString(), wall_ms: Date.now(), env_id: envId },
    payload: { scope: { cwd: scopeCwd }, barrier: { spool_files_before: before.reduce((n, b) => n + b.names.size, 0), drained }, sessions },
  });
  return { entry, sessions, raw };
}
