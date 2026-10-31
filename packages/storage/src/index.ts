import { Db } from './db.ts';
import { migrate } from './migrations.ts';
import type { MigrationResult } from './migrations.ts';
import { MIGRATIONS } from './schema.ts';

export { Db, fromJson, toJson, bool, int, journalPragmaFor } from './db.ts';
export type { SqlParams, SqlValue } from './db.ts';
export { migrate } from './migrations.ts';
export type { Migration, MigrationResult } from './migrations.ts';
export { MIGRATIONS, SCHEMA_VERSION } from './schema.ts';
export { newId, nowIso } from './ids.ts';
export type { IdPrefix } from './ids.ts';

/** Open (creating if needed) and migrate the Mini-Summa database. */
export function openDatabase(file: string): { db: Db; migration: MigrationResult } {
  const db = new Db(file);
  try {
    return { db, migration: migrate(db, MIGRATIONS) };
  } catch (err) {
    db.close();
    throw err;
  }
}
