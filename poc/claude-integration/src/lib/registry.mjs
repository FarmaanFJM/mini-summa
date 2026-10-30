import fs from 'node:fs';
import path from 'node:path';

// Project registry across file-system namespaces.
//
// A directory is identified by (fs, path), where fs is one of:
//   win           a Windows drive path, compared case-insensitively
//   wsl:<Distro>  a path inside one WSL distribution's own file system, case-sensitive
//   posix         plain Linux or macOS
// The same directory can be reached through several spellings, and they all canonicalize to one key:
//   C:\Dev\App   (Windows process)      -> win   c:\dev\app
//   /mnt/c/Dev/App   (WSL process)      -> win   c:\dev\app      (default automount root /mnt/)
//   \\wsl$\Ubuntu\home\u\app (Windows)  -> wsl:Ubuntu  /home/u/app
// Identical-looking POSIX paths in two distributions, or in WSL and a native Linux host, stay different.

const UNC_WSL = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]+([^\\/]+)((?:[\\/].*)?)$/i;

export function detectEnv(platform = process.platform, env = process.env) {
  if (platform === 'win32') return 'win';
  if (env.WSL_DISTRO_NAME) return `wsl:${env.WSL_DISTRO_NAME}`;
  return 'posix';
}

const stripTrailing = (p, sep) => (p.length > 1 && p.endsWith(sep) && !/^[a-z]:\\$/.test(p) ? p.replace(new RegExp(`\\${sep}+$`), '') : p);

export function canonicalize(p, env, opts = {}) {
  if (typeof p !== 'string' || p === '') return null;
  const automount = (opts.automount ?? '/mnt/').replace(/\/?$/, '/');
  if (env === 'win') {
    const unc = UNC_WSL.exec(p);
    if (unc) {
      const rest = path.posix.normalize('/' + unc[2].replace(/\\/g, '/'));
      return { fs: `wsl:${unc[1]}`, path: stripTrailing(rest, '/') };
    }
    const n = path.win32.normalize(p).toLowerCase();
    return { fs: 'win', path: stripTrailing(n, '\\') };
  }
  const n = stripTrailing(path.posix.normalize(p), '/');
  if (env.startsWith('wsl:')) {
    const base = automount.replace(/\/$/, '');
    const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([a-zA-Z])(/.*)?$`).exec(n);
    if (m) return { fs: 'win', path: stripTrailing(`${m[1].toLowerCase()}:${(m[2] ?? '\\').replace(/\//g, '\\')}`.toLowerCase(), '\\') };
    return { fs: env, path: n };
  }
  return { fs: 'posix', path: n };
}

// Back-compat helper used by older callers and tests.
export function normPath(p, platform = process.platform) {
  const c = canonicalize(p, platform === 'win32' ? 'win' : 'posix');
  return c ? c.path : null;
}

const within = (root, dir) => {
  if (root.fs !== dir.fs) return false;
  const sep = root.fs === 'win' ? '\\' : '/';
  return dir.path === root.path || dir.path.startsWith(root.path.endsWith(sep) ? root.path : root.path + sep);
};

export function createRegistry(config, opts = {}) {
  const nativeEnv = opts.platform ? (opts.platform === 'win32' ? 'win' : 'posix') : detectEnv();
  const defaultEnv = config.defaultEnv ?? nativeEnv;
  const real = opts.real ?? true;
  const automount = config.automount ?? '/mnt/';
  const canon = (p, env) => {
    let q = p;
    if (real && env === nativeEnv && env === detectEnv()) { try { q = fs.realpathSync.native(p); } catch { /* may not exist */ } }
    return canonicalize(q, env, { automount });
  };
  const roots = [];
  for (const proj of config.projects ?? []) {
    for (const r of proj.roots ?? []) {
      const spec = typeof r === 'string' ? { path: r, env: defaultEnv } : { env: defaultEnv, ...r };
      const c = canon(spec.path, spec.env);
      if (c) roots.push({ project: { id: proj.id, name: proj.name }, root: c });
    }
  }
  return {
    defaultEnv,
    resolve(cwd, env = defaultEnv) {
      const d = canon(cwd, env);
      if (!d) return { project: null, reason: 'no_cwd' };
      let best = []; let bestLen = -1;
      for (const r of roots) {
        if (within(r.root, d)) {
          if (r.root.path.length > bestLen) { best = [r]; bestLen = r.root.path.length; } else if (r.root.path.length === bestLen) best.push(r);
        }
      }
      if (best.length === 0) return { project: null, reason: 'unregistered_directory', canonical: d };
      const ids = new Set(best.map((b) => b.project.id));
      if (ids.size > 1) return { project: null, reason: 'ambiguous', candidates: [...ids] };
      return { project: best[0].project, reason: 'matched', canonical: d };
    },
  };
}

export function loadRegistry(file, opts) {
  return createRegistry(JSON.parse(fs.readFileSync(file, 'utf8')), opts);
}
