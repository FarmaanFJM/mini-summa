# @minisumma/claude-integration

The verified Claude Code integration layer of Mini-Summa. It observes real Claude Code sessions through documented
mechanisms only (user-level hooks, `claude agents --json`, and `last_assistant_message`) and turns them into sessions,
states, generations and reports. Plain ES modules for Node 22 or newer, no runtime dependencies, hand-written types.

It is the proof of concept from Experiment A (`poc/claude-integration`) ported with its whole regression suite. The
behaviour that suite pins down is the foundation of the product: hook capture, event identity, session generations,
discovery intervals, the report-marker protocol, and Windows / WSL / POSIX path canonicalization. The proof of concept
directory stays untouched as the research record; its own tests keep running (`npm run test:poc` at the repository root).

## Public API

`src/index.js` has named exports only; the declarations are in `src/index.d.ts`.

| Area | Exports |
|---|---|
| Reducer: raw log to derived events, sessions, generations, reports | `Reducer`, `replay`, `LABELS` |
| Durable raw log (files) | `Store` |
| Spool ingestion for any store | `ingestSpoolFiles`, `pendingSpoolFiles` |
| Project registry across Windows, WSL and POSIX | `createRegistry`, `loadRegistry`, `canonicalize`, `detectEnv`, `normPath` |
| Report protocol | `parseMarker`, `REPORT_INSTRUCTION`, `PROTOCOL_VERSION` |
| Discovery snapshots recorded as an interval | `takeSnapshot`, `tidOfSpoolName` |
| `claude agents --json` | `runAgentsJson`, `normalizeAgents`, `validateAgents`, `pidAlive`, `claudeBin`, `evaluateSeparateDiscovery`, `DOCUMENTED` |
| Hook registration (pure builders) | `hookCommand`, `buildSettings`, `layout`, `isNormalConfigDir`, `EVENTS` |
| Clock domains: when two monotonic stamps may be compared | `clockDomain`, `bootKey`, `markerOf`, `compareMarkers` |
| Redaction applied before anything touches disk | `redactDeep`, `redactString`, `limitStrings` |

The hook script itself is not part of the module API (loading it exits the process). It ships as one standalone file:
`npm run build:hook` bundles `src/hook/capture.mjs` into `dist/capture.mjs` with esbuild. The bundle imports only
`node:` built-ins, always exits 0, prints nothing except the SessionStart report instruction for registered projects, and
writes one atomic spool file per invocation. `dist/` is git-ignored.

## How the product uses it

1. **Register the hook.** The app copies `dist/capture.mjs` next to its data and writes user-level hooks with
   `buildSettings`. When the user has no node on PATH it uses its own Electron executable as `node`, together with
   `runAsNode: true`, so each command sets `ELECTRON_RUN_AS_NODE=1` for that one invocation (POSIX and WSL:
   `ELECTRON_RUN_AS_NODE=1 "<exe>" "<capture>" ...`; Windows, run in PowerShell:
   `$env:ELECTRON_RUN_AS_NODE='1'; & "<exe>" "<capture>" ...`). Without `runAsNode` the command lines are byte-identical to
   the proof of concept's, and paths that are unsafe inside a shell string are still refused.
2. **Ingest.** The core will call `ingestSpoolFiles(spoolDir, { only }, appendRaw)` with an `appendRaw` backed by its SQLite
   store. `appendRaw` must be idempotent per `transport_id` and return `null` for a receipt it already has. The same
   function drives `Store` (files), so the ordering, quarantine and move rules are the ones the tests verify. A store that
   also offers `pendingSpool` and `ingestSpool` satisfies `RawStoreLike` and can be given to `takeSnapshot`.
3. **Derive.** State is a pure function of the ordered raw log: `replay(entries, registry)` gives sessions, generations,
   derived events and reports, and replaying the same log always gives the same result. Nothing is rewritten or dropped.
4. **Reports.** Every report is stored with `verified: false`: the marker is the model's declaration, not evidence that
   the work or its tests succeeded.

```ts
import { buildSettings, ingestSpoolFiles, replay, createRegistry } from '@minisumma/claude-integration';

const settings = buildSettings({ env: 'win', node: appExe, capture: captureMjs, spool, registry: registryFile, runAsNode: true });
ingestSpoolFiles(spool, undefined, (entry) => db.appendRaw(entry)); // db: your durable log; stored row, or null if already ingested
const reducer = replay(db.allRaw(), createRegistry(registryConfig));
```

## What this package adds to the proof of concept

- `src/lib/spool.mjs`: the spool algorithm extracted from `Store.ingestSpool` (`Store` delegates to it, behaviour unchanged).
- `runAsNode` on `hookCommand` and `buildSettings`.
- `src/index.js`, `src/index.d.ts`, `tsconfig.json`, `test/types/usage.ts`: the public API and its types.
- `npm run build:hook`, and `test/bundle.test.mjs` that builds the bundle and runs it as a child process.
- Tests: `spool`, `setup-runasnode`, `bundle`, `api` (the 131 inherited tests are unchanged).
- `docs/POC-README.md` is the proof of concept's README, kept as the evidence table (what was proven, where, and what was not).

## Tests

Run from the repository root:

```
npm test -w @minisumma/claude-integration            # node --test, no network, no Claude calls
npm run typecheck -w @minisumma/claude-integration   # compiles src/index.d.ts and test/types/usage.ts
npm run build:hook -w @minisumma/claude-integration  # writes dist/capture.mjs
npm run test:poc                                     # the untouched proof of concept's own suite
```

The bundle test and the typecheck use esbuild and TypeScript from the repository's `node_modules`. Qualification on a real
machine (hooks, discovery, resume, kill, Windows and WSL2) is a separate procedure: `docs/QUALIFICATION.md`.

## More

`docs/DESIGN.md` has the design rules (components, identity layers, ordering and generations, report protocol, known
limitations). `docs/EXPERIMENT-A.md` records what the live runs found, and `docs/qualification-results/` holds the Linux
qualification runs. Never commit raw hook payloads, transcripts, spools, stores or configuration directories:
`.gitignore` blocks them and `test/publish-guard.test.mjs` fails on tokens, real home paths and harness identifiers.
