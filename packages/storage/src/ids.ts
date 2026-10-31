import { randomBytes } from 'node:crypto';

export type IdPrefix = 'prj' | 'rot' | 'cnv' | 'dlv' | 'dev' | 'act' | 'ntf' | 'off' | 'evt' | 'run' | 'cand';

/** Short, prefixed, URL-safe identifiers: `prj_3f9a1c20b7d4e611`. The prefix makes logs and support readable. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export const nowIso = (): string => new Date().toISOString();
