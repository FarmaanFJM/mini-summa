import { runAgentsJson, normalizeAgents, pidAlive } from './discovery.mjs';

// A discovery call is NOT an instant. `claude agents --json` takes time, and hooks keep arriving while it runs.
// So a snapshot records an INTERVAL and classifies every hook receipt against it:
//
//   BEFORE     present in the spool when the call started. Ingested first, so it precedes the snapshot in the log.
//   UNCERTAIN  appeared while the call was in flight (present in the second scan, absent from the first). It may have
//              happened before or after the instant at which Claude took its observation. Listed in
//              interval.uncertain by transport id.
//   AFTER      not present even after the call returned. It landed after the observation was complete.
//
// "Landed" means the atomic rename into the spool. It is the arrival of the record, which is all this scheme claims;
// how long a hook process itself ran before landing is not bounded by anything the interface documents.
// No clock is consulted and no delay is assumed.
export const tidOfSpoolName = (name) => (/^\d+-(.+)\.json$/.exec(name) ?? [])[1] ?? name;

export async function takeSnapshot({ store, spools = [], envId, run = runAgentsJson, runOpts = {}, scopeCwd = null, remote = false }) {
  const scan = () => spools.map((dir) => ({ dir, names: new Set(store.pendingSpool(dir)) }));
  const before = scan();
  let raw;
  try {
    ({ raw } = await run({ ...runOpts, cwd: scopeCwd ?? undefined }));
  } catch (err) {
    // A failed or interrupted call observed nothing. Record that fact for the audit trail; do NOT record a snapshot,
    // so nothing can be inferred as gone. Pending hooks stay in the spool and are ingested by the normal path.
    store.appendRaw({ kind: 'discovery_error', transport: { received_at: new Date().toISOString(), wall_ms: Date.now(), env_id: envId },
      payload: { message: String(err?.message ?? err).slice(0, 300), pending_before: before.reduce((n, b) => n + b.names.size, 0) } });
    throw err;
  }
  const after = scan();
  let drained = 0; const uncertain = [];
  before.forEach((b, i) => {
    drained += store.ingestSpool(b.dir, { only: b.names }).ingested;
    for (const name of after[i].names) if (!b.names.has(name)) uncertain.push(tidOfSpoolName(name));
  });
  const sessions = normalizeAgents(raw).map(({ _extra_keys, ...x }) => ({ ...x, pid_alive: pidAlive(x.pid, { remote }) }));
  const entry = store.appendRaw({
    kind: 'discovery',
    transport: { received_at: new Date().toISOString(), wall_ms: Date.now(), env_id: envId },
    payload: { scope: { cwd: scopeCwd }, interval: { complete: true, before_files: before.reduce((n, b) => n + b.names.size, 0), drained, uncertain: uncertain.sort() }, sessions },
  });
  return { entry, sessions, raw };
}
