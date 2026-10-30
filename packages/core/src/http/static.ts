// Serves the built renderer under /ui/.
//
// The URL path is decoded once, segment by segment, and every segment must be a plain file name: no separators, no
// dot segments or dot files, no leftover percent signs (a double-encoded `%252e` would otherwise survive one decode),
// no `:` (drive letters and NTFS streams) and no Windows device names. The resolved real path must also stay inside
// the UI directory, so a symlink cannot lead out of it. Anything else is a 404, never an SPA fallback.
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { errorBody, jsonResponse } from './responses.ts';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8', txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm',
};

export const contentTypeOf = (file: string): string =>
  MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** The decoded file-name segments of a /ui path, or null when any of them is not acceptable. */
export function safeSegments(pathname: string): string[] | null {
  const rest = pathname.replace(/^\/ui/, '');
  const out: string[] = [];
  for (const raw of rest.split('/')) {
    if (raw === '') continue;
    let seg: string;
    try { seg = decodeURIComponent(raw); } catch { return null; }
    if (seg === '' || seg.startsWith('.') || /[\\/%:\0]/.test(seg) || DEVICE_NAME.test(seg)) return null;
    out.push(seg);
  }
  return out;
}

const notFound = () => jsonResponse(404, errorBody('not_found', 'That page does not exist in the Mini-Summa interface.'));

async function statOrNull(p: string): Promise<Stats | null> {
  try { return await fs.stat(p); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG' || code === 'EINVAL') return null;
    throw err;
  }
}

const inside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

export interface StaticUi { serve(pathname: string): Promise<Response> }

export function createStaticUi(uiDir: string | undefined): StaticUi {
  return {
    async serve(pathname) {
      if (!uiDir) {
        return jsonResponse(404, errorBody('ui_not_available', 'This copy of Mini-Summa has no user interface to show. Use the desktop app, or build the renderer first.'));
      }
      const segments = safeSegments(pathname);
      if (segments === null) return notFound();

      let root: string;
      try { root = await fs.realpath(uiDir); } catch {
        return jsonResponse(404, errorBody('ui_not_available', 'The user interface folder is missing. Reinstall Mini-Summa or rebuild the renderer.'));
      }

      let file = path.join(root, ...segments);
      let st = await statOrNull(file);
      if (st?.isDirectory()) { file = path.join(file, 'index.html'); st = await statOrNull(file); }
      if (!st?.isFile()) {
        // A path that names a file (has an extension) but does not exist is a real 404. Anything else is an app route.
        const last = segments[segments.length - 1] ?? '';
        if (/\.[A-Za-z0-9]{1,10}$/.test(last)) return notFound();
        file = path.join(root, 'index.html');
        st = await statOrNull(file);
        if (!st?.isFile()) return jsonResponse(404, errorBody('ui_not_available', 'The user interface has no index.html. Rebuild the renderer.'));
      }

      let real: string;
      try { real = await fs.realpath(file); } catch { return notFound(); }
      if (!inside(root, real)) return notFound();

      let data: Buffer;
      try { data = await fs.readFile(real); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return notFound();
        throw err;
      }
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { 'content-type': contentTypeOf(real), 'content-length': String(data.byteLength), 'cache-control': 'no-cache' },
      });
    },
  };
}
