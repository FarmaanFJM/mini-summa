// Draws the extension icons with nothing but Node: the Mini-Summa logo (assets/brand/mini-summa-logo.png) on a charcoal rounded square.
// Usage: node scripts/make-icons.mjs <output directory>
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { renderBrandMark } from '../../../scripts/brand/logo-raster.mjs';

export const ICON_SIZES = [16, 32, 48, 128];

/** RGBA pixels, size x size: the Mini-Summa logo on a charcoal rounded square (see scripts/brand/logo-raster.mjs at the repository root). */
export function renderIconPixels(size) {
  return renderBrandMark(size);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([head, body, crc]);
}

/** A complete PNG file (8-bit RGBA, no interlace). */
export function renderIconPng(size) {
  const pixels = renderIconPixels(size);
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter type: none
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Writes icon-<size>.png for every size and returns the file names. */
export async function writeIcons(dir, sizes = ICON_SIZES) {
  await mkdir(dir, { recursive: true });
  const names = [];
  for (const size of sizes) {
    const name = `icon-${size}.png`;
    await writeFile(path.join(dir, name), renderIconPng(size));
    names.push(name);
  }
  return names;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) { console.error('Usage: node scripts/make-icons.mjs <output directory>'); process.exit(1); }
  console.log((await writeIcons(dir)).map((n) => path.join(dir, n)).join('\n'));
}
