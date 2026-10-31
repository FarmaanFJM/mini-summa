// Builds the extension into dist/ (background.js, options.js, options.html, options.css, manifest.json, icons/).
//
//   node build.mjs                  production build
//   node build.mjs --test-hosts     TEST build for the real-browser test: labelled as a test build and guaranteed to
//                                   allow the loopback patterns. Never publish or load this one for daily use.
//   node build.mjs --out <dir>      write somewhere else than dist/
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeIcons } from './scripts/make-icons.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const sharedSrc = path.join(repoRoot, 'packages', 'shared', 'src') + path.sep;
const guidanceCss = path.join(repoRoot, 'third_party', 'summa-ui-guidance', 'css');

/** Loopback host patterns a test build must allow, so local pages can stand in for the core and its pages. */
export const TEST_HOST_PERMISSIONS = ['http://localhost/*', 'http://127.0.0.1/*'];

/** The manifest that is written to dist/. Production is manifest.json unchanged. */
export function transformManifest(manifest, { testHosts = false } = {}) {
  const out = structuredClone(manifest);
  if (testHosts) {
    out.name = `${manifest.name} (test build)`;
    out.version_name = `${manifest.version} test-hosts`;
    out.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...TEST_HOST_PERMISSIONS])];
  }
  return out;
}

// @minisumma/shared re-exports modules that build zod schemas at load time (routes.ts), which esbuild must assume have
// side effects and would bundle (about 450 KB). The extension only needs the pure URL and pairing helpers, so mark the
// shared sources side effect free and let unused modules drop out.
const sharedIsPure = {
  name: 'shared-is-side-effect-free',
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData === 'passthrough') return undefined;
      const resolved = await b.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir, kind: args.kind, pluginData: 'passthrough' });
      if (resolved.errors.length > 0) return resolved;
      return resolved.path.startsWith(sharedSrc) ? { ...resolved, sideEffects: false } : resolved;
    });
  },
};

async function composeCss() {
  const read = async (file) => {
    try { return await readFile(file, 'utf8'); } catch {
      throw new Error(`Cannot read ${file}. The options page uses the pinned Summa-UI guidance in third_party/summa-ui-guidance.`);
    }
  };
  const parts = [
    '/* Summa-UI guidance bundle (third_party/summa-ui-guidance, pinned in summa-ui.lock.json), then the page rules. */',
    await read(path.join(guidanceCss, 'tokens.css')),
    await read(path.join(guidanceCss, 'presets.css')),
    await read(path.join(here, 'src', 'options.css')),
  ];
  return parts.join('\n');
}

export async function buildExtension({ outDir = path.join(here, 'dist'), testHosts = false } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await build({
    absWorkingDir: here,
    entryPoints: { background: 'src/background.ts', options: 'src/options.ts' },
    outdir: outDir,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome121'],
    minify: false, // readable output: people are asked to trust this extension, so let them read it
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    plugins: [sharedIsPure],
  });

  await copyFile(path.join(here, 'options.html'), path.join(outDir, 'options.html'));
  await writeFile(path.join(outDir, 'options.css'), await composeCss());
  const manifest = JSON.parse(await readFile(path.join(here, 'manifest.json'), 'utf8'));
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(transformManifest(manifest, { testHosts }), null, 2)}\n`);
  await writeIcons(path.join(outDir, 'icons'));

  const sizes = {};
  for (const name of ['background.js', 'options.js', 'options.css', 'options.html', 'manifest.json']) sizes[name] = (await stat(path.join(outDir, name))).size;
  return { outDir, testHosts, sizes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outDir = outIndex >= 0 ? path.resolve(args[outIndex + 1] ?? '') : path.join(here, 'dist');
  const result = await buildExtension({ outDir, testHosts: args.includes('--test-hosts') });
  const rows = Object.entries(result.sizes).map(([name, size]) => `  ${name.padEnd(14)} ${String(size).padStart(7)} bytes`);
  console.log(`Built ${result.testHosts ? 'TEST (test-hosts)' : 'production'} extension in ${result.outDir}\n${rows.join('\n')}`);
}
