import type { Db } from './db.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: { version: number; name: string }[];
}

/**
 * Forward-only migrations. Each one runs in its own transaction together with its bookkeeping row, so a crash leaves
 * the database at the previous version. A database newer than this build is refused rather than guessed at.
 */
export function migrate(db: Db, migrations: Migration[], now: () => string = () => new Date().toISOString()): MigrationResult {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].version === sorted[i - 1].version) throw new Error(`Duplicate migration version ${sorted[i].version}`);
  }
  const current = db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0;
  const newest = sorted.length ? sorted[sorted.length - 1].version : 0;
  if (current > newest) {
    throw new Error(`The database is at schema version ${current}, but this build only knows up to ${newest}. Update Mini-Summa instead of opening this database with an older version.`);
  }
  const applied: MigrationResult['applied'] = [];
  for (const m of sorted) {
    if (m.version <= current) continue;
    db.tx(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, now()]);
    });
    applied.push({ version: m.version, name: m.name });
  }
  return { from: current, to: Math.max(current, newest), applied };
}
