// Is a folder that is about to become a project folder really there? Answered only for folders on this computer's own file system
// (the environment Mini-Summa runs in). A folder inside a WSL distribution is read through a network path that may be slow or
// asleep, so it is accepted as typed and checked when a session starts.
import fs from 'node:fs';
import type { EnvId } from '@minisumma/shared';

export interface FolderProblem { code: 'root_not_found' | 'root_not_directory' | 'root_not_readable'; message: string }

export type FolderCheck = (env: EnvId, path: string) => FolderProblem | null;

export function hostFolderCheck(hostEnv: EnvId, stat: (path: string) => fs.Stats = (p) => fs.statSync(p)): FolderCheck {
  return (env, path) => {
    if (env !== hostEnv) return null;
    try {
      if (!stat(path).isDirectory()) {
        return { code: 'root_not_directory', message: `That is a file, not a folder: ${path}. Choose the folder that contains it.` };
      }
      return null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { code: 'root_not_found', message: `This folder does not exist: ${path}. Check the spelling, or choose it with Browse.` };
      if (code === 'ENOTDIR') return { code: 'root_not_directory', message: `Part of this path is a file, not a folder: ${path}. Check the path.` };
      if (code === 'EACCES' || code === 'EPERM') {
        return { code: 'root_not_readable', message: `Mini-Summa is not allowed to open this folder: ${path}. Choose another folder, or change its permissions.` };
      }
      return null; // anything else (a drive that is slow to answer, say) is not a reason to refuse: starting a session says what is wrong
    }
  };
}
