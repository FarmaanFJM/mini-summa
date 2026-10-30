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

// What `claude agents --json` printed, as the sessions a snapshot records. Throws if it is not a listing: not an array, or an
// entry that is not an object (a row of nulls would otherwise be recorded as a session nobody can identify).
function sessionsOf(raw, remote) {
  if (!Array.isArray(raw)) throw new Error('claude agents --json did not return an array');
  raw.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`claude agents --json entry ${i} is not an object`);
  });
  return normalizeAgents(raw).map(({ _extra_keys, ...x }) => ({ ...x, pid_alive: pidAlive(x.pid, { remote }) }));
}

export async function takeSnapshot({ store, spools = [], envId, run = runAgentsJson, runOpts = {}, scopeCwd = null, remote = false }) {
  const scan = () => spools.map((dir) => ({ dir, names: new Set(store.pendingSpool(dir)) }));
  const before = scan();
  const pendingBefore = before.reduce((n, b) => n + b.names.size, 0);
  // A call that failed, was interrupted, or printed something that is not a listing observed nothing. Record that fact for
  // the audit trail; do NOT record a snapshot, so nothing can be inferred as gone, and do not drain the spool. Pending
  // hooks stay where they are and are ingested by the normal path.
  const observedNothing = (err) => store.appendRaw({ kind: 'discovery_error', transport: { received_at: new Date().toISOString(), wall_ms: Date.now(), env_id: envId },
    payload: { message: String(err?.message ?? err).slice(0, 300), pending_before: pendingBefore } });
  let raw;
  try {
    ({ raw } = await run({ ...runOpts, cwd: scopeCwd ?? undefined }));
  } catch (err) {
    observedNothing(err);
    throw err;
  }
  const after = scan();
  let sessions;
  try {
    sessions = sessionsOf(raw, remote); // validated before anything is drained, so invalid output is handled like a failed call
  } catch (err) {
    observedNothing(err);
    throw err;
  }
  let drained = 0; const uncertain = [];
  before.forEach((b, i) => {
    drained += store.ingestSpool(b.dir, { only: b.names }).ingested;
    for (const name of after[i].names) if (!b.names.has(name)) uncertain.push(tidOfSpoolName(name));
  });
  const entry = store.appendRaw({
    kind: 'discovery',
    transport: { received_at: new Date().toISOString(), wall_ms: Date.now(), env_id: envId },
    payload: { scope: { cwd: scopeCwd }, interval: { complete: true, before_files: pendingBefore, drained, uncertain: uncertain.sort() }, sessions },
  });
  return { entry, sessions, raw };
}
