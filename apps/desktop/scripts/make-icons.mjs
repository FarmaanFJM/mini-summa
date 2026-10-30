#!/usr/bin/env node
// Draws the Mini-Summa mark (an emerald sigma on a charcoal rounded square) with nothing but node:zlib: no image
// libraries, no external assets. Colors are the Summa-UI tokens: charcoal --s0/--s1/--s3, emerald --accent.
//
//   node apps/desktop/scripts/make-icons.mjs
//
// Writes build/icon.png (512), build/icon.ico (16..256, PNG-compressed entries), resources/icon.png (256) and
// resources/tray.png (32) + tray@2x.png (64). The output is deterministic, so re-running changes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const CHARCOAL_TOP = [0x1b, 0x1c, 0x1c];
const CHARCOAL_BOTTOM = [0x14, 0x15, 0x15];
const EDGE = [0x2c, 0x2d, 0x2d];
const EMERALD = [0x10, 0xb9, 0x81];

// Sigma, in unit coordinates: serif, top bar, diagonal to the vertex, diagonal back, bottom bar, serif.
const SIGMA = [[0.745, 0.35], [0.745, 0.275], [0.275, 0.275], [0.525, 0.5], [0.275, 0.725], [0.745, 0.725], [0.745, 0.65]];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function roundedRectSdf(x, y, size, radius) {
  const h = size / 2;
  const qx = Math.abs(x - h) - (h - radius);
  const qy = Math.abs(y - h) - (h - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** RGBA pixels for one size. Each size is drawn from scratch so small icons stay crisp. */
export function drawMark(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const stroke = Math.max(1.6, size * 0.092);
  const edge = Math.max(1, size / 64);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const body = clamp01(0.5 - roundedRectSdf(cx, cy, size, radius));
      let rgb = mix(CHARCOAL_TOP, CHARCOAL_BOTTOM, cy / size);
      // A hairline of the raised-surface tone keeps the shape readable on dark backgrounds.
      const inside = -roundedRectSdf(cx, cy, size, radius);
      rgb = mix(rgb, EDGE, clamp01(1 - inside / edge) * 0.9);
      let d = Infinity;
      for (let i = 0; i < SIGMA.length - 1; i += 1) {
        d = Math.min(d, distanceToSegment(cx, cy, SIGMA[i][0] * size, SIGMA[i][1] * size, SIGMA[i + 1][0] * size, SIGMA[i + 1][1] * size));
      }
      rgb = mix(rgb, EMERALD, clamp01(0.5 - (d - stroke / 2)));
      const i = (y * size + x) * 4;
      px[i] = Math.round(rgb[0]);
      px[i + 1] = Math.round(rgb[1]);
      px[i + 2] = Math.round(rgb[2]);
      px[i + 3] = Math.round(body * 255);
    }
  }
  return px;
}

// ---- PNG and ICO encoders ----------------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};

export function encodePng(size, rgba) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const png = (size) => encodePng(size, drawMark(size));
  const write = (rel, data) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    console.log(`${rel}  ${data.length} bytes`);
  };
  write('build/icon.png', png(512));
  write('build/icon.ico', encodeIco([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) }))));
  write('resources/icon.png', png(256));
  write('resources/tray.png', png(32));
  write('resources/tray@2x.png', png(64));
}
