// Draws the extension icons with nothing but Node: a small anti-aliased rasterizer and a PNG encoder.
// The mark is two browser tabs on a charcoal rounded square: an outlined one behind, the emerald one brought forward.
// Usage: node scripts/make-icons.mjs <output directory>
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

export const ICON_SIZES = [16, 32, 48, 128];

const CHARCOAL = [0x23, 0x24, 0x24];
const GREY = [0xa3, 0xa6, 0xa4];
const EMERALD = [0x10, 0xb9, 0x81];

// Shapes in unit coordinates, painted in order. A stroke is drawn around the outline of its rectangle.
const SHAPES = [
  { kind: 'fill', rect: [0, 0, 1, 1], radius: 0.22, color: CHARCOAL },
  { kind: 'stroke', rect: [0.17, 0.17, 0.69, 0.62], radius: 0.08, width: 0.065, color: GREY },
  // A charcoal margin around the front tab cuts the back tab's outline so the two read as overlapping.
  { kind: 'fill', rect: [0.25, 0.32, 0.89, 0.89], radius: 0.13, color: CHARCOAL },
  { kind: 'fill', rect: [0.31, 0.38, 0.83, 0.83], radius: 0.08, color: EMERALD },
];

/** Signed distance from point (x, y) to a rounded rectangle: negative inside, positive outside. */
function distance(x, y, [x0, y0, x1, y1], radius) {
  const hx = (x1 - x0) / 2;
  const hy = (y1 - y0) / 2;
  const qx = Math.abs(x - (x0 + x1) / 2) - (hx - radius);
  const qy = Math.abs(y - (y0 + y1) / 2) - (hy - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function sample(x, y) {
  let color = null;
  for (const shape of SHAPES) {
    const d = distance(x, y, shape.rect, shape.radius);
    const covered = shape.kind === 'fill' ? d <= 0 : Math.abs(d) <= shape.width / 2;
    if (covered) color = shape.color;
  }
  return color;
}

/** RGBA pixels, size x size, each averaged over a 4x4 grid of samples. */
export function renderIconPixels(size) {
  const grid = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0; let g = 0; let b = 0; let hits = 0;
      for (let sy = 0; sy < grid; sy++) {
        for (let sx = 0; sx < grid; sx++) {
          const c = sample((px + (sx + 0.5) / grid) / size, (py + (sy + 0.5) / grid) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; hits++; }
        }
      }
      const i = (py * size + px) * 4;
      if (hits > 0) {
        out[i] = Math.round(r / hits); out[i + 1] = Math.round(g / hits); out[i + 2] = Math.round(b / hits);
        out[i + 3] = Math.round((255 * hits) / (grid * grid));
      }
    }
  }
  return out;
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
