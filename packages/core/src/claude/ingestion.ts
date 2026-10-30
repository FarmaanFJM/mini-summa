// The ingestion loop: moves hook receipts from every environment's spool directory into the raw log, then asks for
// "everything after lastAppliedSeq" to be applied and published.
//
// Polling is the mechanism (spoolPollMs, default 700 ms). Watching a directory is unreliable on Windows and on WSL
// mounts, so nothing here depends on it. Every pass goes through the shared SerialQueue: a pass never overlaps another
// pass or a discovery call, which is what the discovery interval classification relies on.
//
// Backlog: files already in a spool when the app starts (or when an environment first shows up) happened while nobody
// was watching. They are ingested as catch-up and applied as replay, so old permission prompts do not turn into fresh
// notifications.
import type { EnvId } from '@minisumma/shared';
import type { EnvLayout, EnvironmentsService, Logger } from '../contracts.ts';
import type { RawStore } from './rawStore.ts';
import type { SerialQueue } from './serialQueue.ts';

export interface IngestionDeps {
  queue: SerialQueue;
  rawStore: Pick<RawStore, 'ingestSpool'>;
  hostEnv: EnvId;
  environments: Pick<EnvironmentsService, 'list' | 'layout'>;
  /** Milliseconds between passes. 0 or less = no automatic passes (tests drive them with pass()). */
  pollMs: number;
  /** Applies everything after lastAppliedSeq and publishes it. Cheap when there is nothing new. */
  apply(opts: { replay: boolean }): void | Promise<void>;
  log: Pick<Logger, 'debug' | 'warn' | 'error'>;
}

export interface DrainResult {
  ingested: number;
  alreadyIngested: number;
  quarantined: number;
}

export interface Ingestion {
  /** Resolves the host environment's layout. Call before start() and drainKnown(). */
  prepare(): Promise<void>;
  /** Ingests the pending spool of every known layout right now (synchronously). The caller applies. */
  drainKnown(): DrainResult;
  /** One queued pass: ingest every known layout, then apply. */
  pass(): Promise<DrainResult>;
  /** Learns about more environments (WSL distributions) and catches up their backlog as replay. Safe to call often. */
  syncEnvironments(): Promise<void>;
  start(): void;
  stop(): void;
  layouts(): EnvLayout[];
}

const empty = (): DrainResult => ({ ingested: 0, alreadyIngested: 0, quarantined: 0 });

export function createIngestion(deps: IngestionDeps): Ingestion {
  const { queue, rawStore, environments, log } = deps;
  const layouts = new Map<EnvId, EnvLayout>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let syncing: Promise<void> | null = null;

  function drainOne(layout: EnvLayout): DrainResult {
    try {
      const r = rawStore.ingestSpool(layout.spoolDirHost);
      if (r.quarantined > 0) log.warn('Some hook files were not valid Mini-Summa records and were moved to quarantine.', { env: layout.env, files: r.quarantined });
      return { ingested: r.ingested, alreadyIngested: r.already_ingested, quarantined: r.quarantined };
    } catch (err) {
      log.warn('Could not read a hook spool directory.', { env: layout.env, dir: layout.spoolDirHost, error: err instanceof Error ? err.message : String(err) });
      return empty();
    }
  }

  function drainKnown(): DrainResult {
    const total = empty();
    for (const layout of layouts.values()) {
      const r = drainOne(layout);
      total.ingested += r.ingested;
      total.alreadyIngested += r.alreadyIngested;
      total.quarantined += r.quarantined;
    }
    return total;
  }

  const pass = (): Promise<DrainResult> => queue.run(async () => {
    const result = drainKnown();
    await deps.apply({ replay: false });
    return result;
  });

  function schedule(): void {
    if (stopped || !(deps.pollMs > 0)) return;
    timer = setTimeout(() => { void tick(); }, deps.pollMs);
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    timer = null;
    if (stopped) return;
    try {
      await pass();
    } catch (err) {
      log.error('A spool ingestion pass failed.', { error: err instanceof Error ? err.message : String(err) });
    }
    schedule();
  }

  async function syncOnce(): Promise<void> {
    const fresh: EnvLayout[] = [];
    for (const info of await environments.list()) {
      if (layouts.has(info.id)) continue;
      try {
        const layout = await environments.layout(info.id);
        layouts.set(info.id, layout);
        fresh.push(layout);
      } catch (err) {
        log.warn('An environment has no usable layout, so its hooks cannot be read.', { env: info.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (fresh.length === 0) return;
    await queue.run(async () => {
      for (const layout of fresh) drainOne(layout);
      await deps.apply({ replay: true });
    });
  }

  return {
    async prepare() {
      try {
        layouts.set(deps.hostEnv, await environments.layout(deps.hostEnv));
      } catch (err) {
        log.error('The host environment has no usable layout; hook events cannot be read.', { error: err instanceof Error ? err.message : String(err) });
      }
    },
    drainKnown,
    pass,
    syncEnvironments() {
      if (!syncing) syncing = syncOnce().finally(() => { syncing = null; });
      return syncing;
    },
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    layouts: () => [...layouts.values()],
  };
}
