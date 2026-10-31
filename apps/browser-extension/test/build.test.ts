// Builds the extension into a temporary folder and inspects what would be loaded into the browser.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildExtension } from '../build.mjs';
import { ICON_SIZES, renderIconPng } from '../scripts/make-icons.mjs';

let tmp: string;
let prod: string;
let testBuild: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'minisumma-ext-build-'));
  prod = path.join(tmp, 'prod');
  testBuild = path.join(tmp, 'test');
  await buildExtension({ outDir: prod });
  await buildExtension({ outDir: testBuild, testHosts: true });
}, 60_000);

afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

const text = (dir: string, name: string): Promise<string> => readFile(path.join(dir, name), 'utf8');

describe('production build', () => {
  it('writes every file the manifest refers to', async () => {
    const manifest = JSON.parse(await text(prod, 'manifest.json')) as { background: { service_worker: string }; options_ui: { page: string }; icons: Record<string, string> };
    for (const file of [manifest.background.service_worker, manifest.options_ui.page, 'options.js', 'options.css', ...Object.values(manifest.icons)]) {
      expect((await stat(path.join(prod, file))).size, file).toBeGreaterThan(100);
    }
  });

  it('writes the source manifest unchanged', async () => {
    const source = JSON.parse(await readFile(path.join(import.meta.dirname ?? '.', '..', 'manifest.json'), 'utf8'));
    expect(JSON.parse(await text(prod, 'manifest.json'))).toEqual(source);
  });

  it('keeps the bundles small: no zod and none of the HTTP route table in the worker or the options page', async () => {
    for (const file of ['background.js', 'options.js']) {
      const js = await text(prod, file);
      expect(js.length, file).toBeLessThan(60_000);
      expect(js, file).not.toMatch(/zod/i);
      expect(js, file).not.toContain('pairing.createOffer'); // a name from the shared route table
    }
  });

  it('contains no dynamic code loading in the output', async () => {
    for (const file of ['background.js', 'options.js']) {
      const js = await text(prod, file);
      expect(js, file).not.toMatch(/\beval\s*\(|new Function\s*\(|importScripts\s*\(|\bimport\s*\(/);
      expect(js, file).not.toContain('chrome.scripting');
      expect(js, file).not.toContain('executeScript');
    }
  });

  it('the shipped bundles call exactly the chrome.* APIs that bridge.ts documents, and no others', async () => {
    // esbuild renames the injected `chrome` parameter (chrome2, ...), so accept a numeric suffix.
    const used = new Set<string>();
    for (const file of ['background.js', 'options.js']) {
      for (const m of (await text(prod, file)).matchAll(/\bchrome\d*\.([a-zA-Z]+)\.([a-zA-Z]+)/g)) used.add(`${m[1]}.${m[2]}`);
    }
    expect([...used].sort()).toEqual([
      'action.onClicked',
      'alarms.clear', 'alarms.create', 'alarms.get', 'alarms.onAlarm',
      'runtime.id', 'runtime.onMessage', 'runtime.openOptionsPage', 'runtime.sendMessage',
      'storage.local', 'storage.onChanged',
      'tabs.create', 'tabs.get', 'tabs.query', 'tabs.update',
      'windows.update',
    ]);
  });

  it('options.html loads only its own script and stylesheet', async () => {
    const html = await text(prod, 'options.html');
    expect(html).toContain('<script src="options.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="options.css">');
    expect(html).not.toMatch(/(src|href)=["']https?:/); // the only address in the page is the default shown in the Core address field
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/); // no inline script (the extension CSP forbids it anyway)
  });

  it('options.css starts with the pinned Summa-UI tokens and has no remote references', async () => {
    const css = await text(prod, 'options.css');
    expect(css).toContain('--accent: #10b981');
    expect(css).toContain('--s0: #141515');
    expect(css).not.toMatch(/url\(\s*['"]?https?:/);
    expect(css).not.toMatch(/@import/);
    expect(css).toContain('.page {');
  });

  it('is not marked as a test build', async () => {
    const manifest = JSON.parse(await text(prod, 'manifest.json')) as { name: string; version_name?: string };
    expect(manifest.name).not.toMatch(/test/i);
    expect(manifest.version_name).toBeUndefined();
  });
});

describe('test build', () => {
  it('is clearly labelled and differs from production only in its label', async () => {
    const a = JSON.parse(await text(prod, 'manifest.json')) as Record<string, unknown>;
    const b = JSON.parse(await text(testBuild, 'manifest.json')) as Record<string, unknown>;
    expect(b.name).toBe('Mini-Summa tab focus (test build)');
    expect(b.version_name).toBe('0.1.0 test-hosts');
    const { name: _a, ...restA } = a;
    const { name: _b, version_name: _v, ...restB } = b;
    expect(restB).toEqual(restA);
    expect(await text(testBuild, 'background.js')).toBe(await text(prod, 'background.js'));
    expect(await text(testBuild, 'options.js')).toBe(await text(prod, 'options.js'));
  });
});

// A small PNG reader, so the generated icons are checked as images and not just as bytes.
function decodePng(buf: Buffer) {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let pos = 8;
  let width = 0; let height = 0;
  const idat: Buffer[] = [];
  const chunks: string[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    expect(buf.readUInt32BE(pos + 8 + len), `crc of ${type}`).toBe(zlib.crc32(buf.subarray(pos + 4, pos + 8 + len)));
    chunks.push(type);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); expect([data[8], data[9], data[12]]).toEqual([8, 6, 0]); }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe((width * 4 + 1) * height);
  const px = (x: number, y: number): number[] => { const o = y * (width * 4 + 1) + 1 + x * 4; return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]; };
  return { width, height, chunks, px };
}

describe('icons', () => {
  it('are valid PNG files of the sizes the manifest names', async () => {
    for (const size of ICON_SIZES) {
      const png = decodePng(await readFile(path.join(prod, 'icons', `icon-${size}.png`)));
      expect([png.width, png.height]).toEqual([size, size]);
      expect(png.chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
    }
  });

  it('show the Mini-Summa logo (jade owl with infinity eyes) on a charcoal rounded square with transparent corners', () => {
    const png = decodePng(renderIconPng(128));
    expect(png.px(0, 0)[3]).toBe(0); // rounded corner is transparent
    const top = png.px(64, 2); // inside the plate, above the logo
    expect(top[3]).toBe(255);
    expect(top[1]).toBeLessThan(0x40); // charcoal, not a bright colour
    let jade = 0; // the logo's glowing green: clearly more green than red, and bright
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) { const p = png.px(x, y); if (p[3] === 255 && p[1] > 150 && p[1] > p[0] + 60) jade++; }
    expect(jade).toBeGreaterThan(300);
  });

  it('are drawn the same way every time', () => {
    expect(renderIconPng(48).equals(renderIconPng(48))).toBe(true);
  });
});
