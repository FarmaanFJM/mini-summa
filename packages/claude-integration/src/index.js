// Public API of @minisumma/claude-integration. Named exports only; the hand-written declarations are in index.d.ts.
//
// The hook script (src/hook/capture.mjs) is deliberately NOT exported: it is a program that exits the process when it is
// loaded. It ships as a standalone file built with `npm run build:hook` (dist/capture.mjs). The CLIs under src/cli/ and
// the scripts under scripts/ are research tooling and are not part of the API either.

// raw log -> derived events, sessions, generations and reports
export { Reducer, replay, LABELS } from './lib/reducer.mjs';

// durable raw log, and the spool-ingest algorithm a different store can reuse
export { Store } from './lib/store.mjs';
export { ingestSpoolFiles, pendingSpoolFiles } from './lib/spool.mjs';

// project registry across Windows, WSL and POSIX path namespaces
export { createRegistry, canonicalize, detectEnv, loadRegistry, normPath } from './lib/registry.mjs';

// report protocol
export { parseMarker } from './lib/marker.mjs';
export { REPORT_INSTRUCTION, PROTOCOL_VERSION } from './lib/protocol.mjs';

// discovery snapshots (`claude agents --json`) recorded as an interval
export { takeSnapshot, tidOfSpoolName } from './lib/snapshot.mjs';
export {
  runAgentsJson, normalizeAgents, validateAgents, pidAlive, claudeBin, evaluateSeparateDiscovery, DOCUMENTED,
} from './lib/discovery.mjs';

// hook registration (pure builders) and the isolated layout
export { hookCommand, buildSettings, layout, isNormalConfigDir, EVENTS } from './lib/setup.mjs';

// clock domains: when two monotonic timestamps may be compared
export { clockDomain, bootKey, markerOf, compareMarkers } from './lib/clock.mjs';

// redaction applied before anything touches disk
export { redactDeep, redactString, limitStrings } from './lib/redact.mjs';
