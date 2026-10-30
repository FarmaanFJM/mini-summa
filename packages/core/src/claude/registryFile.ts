// The project registry file: <dataDir>/registry.json.
//
// Hook processes read it (`--registry`) to decide whether a session's directory belongs to a project, and only then inject
// the report protocol at SessionStart. The core rewrites it at startup and whenever project roots change. A hook can open
// it at any moment, so it is replaced atomically (temp file, then rename), never edited in place.
import fs from 'node:fs';
import path from 'node:path';
import type { Logger, ProjectsService } from '../contracts.ts';

const RENAME_RETRIES = 6;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Atomic replace. On Windows the rename can fail while a hook process has the old file open, so it is retried briefly. */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= RENAME_RETRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw err;
        await sleep(15 * 2 ** attempt);
      }
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing left to clean */ }
    throw err;
  }
}

export interface RegistryFileWriter {
  /** Writes the file if the contents changed (or the file is gone). Returns whether it wrote. Never throws. */
  write(): Promise<boolean>;
}

export function createRegistryFileWriter(deps: {
  projects: Pick<ProjectsService, 'registryFileContents'>;
  /** Where the file goes, as the core sees it. */
  file: () => Promise<string>;
  log: Pick<Logger, 'warn'>;
}): RegistryFileWriter {
  let lastWritten: { file: string; text: string } | null = null;
  return {
    async write() {
      try {
        const file = await deps.file();
        const text = `${JSON.stringify(deps.projects.registryFileContents(), null, 2)}\n`;
        if (lastWritten && lastWritten.file === file && lastWritten.text === text && fs.existsSync(file)) return false;
        await writeFileAtomic(file, text);
        lastWritten = { file, text };
        return true;
      } catch (err) {
        deps.log.warn('Could not write the project registry file. Hooks keep using the previous one.', { error: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },
  };
}
