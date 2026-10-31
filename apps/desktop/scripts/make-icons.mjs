#!/usr/bin/env node
// Draws the Mini-Summa icons from the logo (assets/brand/mini-summa-logo.png: an owl whose eyes are an infinity sign) on a charcoal
// rounded square, with nothing but node:zlib: no image library. The scaling lives in scripts/brand/logo-raster.mjs.
//
//   node apps/desktop/scripts/make-icons.mjs
//
// Writes build/icon.png (512), build/icon.ico (16..256, PNG-compressed entries), resources/icon.png (256),
// resources/tray.png (32) + tray@2x.png (64) and resources/tray.ico (16, 20, 24, 32, 48 as plain bitmaps). The output is
// deterministic, so re-running changes nothing.
//
// Why a separate tray.ico: Electron turns a PNG tray icon into a single 32-pixel bitmap on Windows, which the notification area
// then shrinks to 16, 20, 24 or 32 pixels depending on the display scale. An .ico lets Windows pick the frame of exactly the
// right size (Electron's documentation recommends it). The frames are uncompressed 32-bit bitmaps, not PNG, because that is what
// every Windows icon loader has always understood; sizes 20 and 24 cover 125% and 150% scaling.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { encodePng as encodeLogoPng, renderBrandMark, renderLogoOnly } from '../../../scripts/brand/logo-raster.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/** RGBA pixels for one size: the Mini-Summa logo (assets/brand/mini-summa-logo.png) on a charcoal rounded square. */
export function drawMark(size) {
  return renderBrandMark(size);
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

/**
 * An .ico whose frames are 32-bit bitmaps (BITMAPINFOHEADER, bottom-up BGRA pixels, then an all-zero AND mask), the classic
 * layout. `images` are { size, rgba } with top-down RGBA pixels as drawMark returns them.
 */
export function encodeIcoDib(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const frames = images.map(({ size, rgba }) => {
    const maskRow = Math.ceil(size / 32) * 4; // 1 bit per pixel, rows padded to 4 bytes
    const info = Buffer.alloc(40);
    info.writeUInt32LE(40, 0); // biSize
    info.writeInt32LE(size, 4); // biWidth
    info.writeInt32LE(size * 2, 8); // biHeight: XOR bitmap plus AND mask
    info.writeUInt16LE(1, 12); // biPlanes
    info.writeUInt16LE(32, 14); // biBitCount
    info.writeUInt32LE(size * size * 4 + maskRow * size, 20); // biSizeImage
    const xor = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const from = (y * size + x) * 4;
        const to = ((size - 1 - y) * size + x) * 4; // bottom-up
        xor[to] = rgba[from + 2]; // B
        xor[to + 1] = rgba[from + 1]; // G
        xor[to + 2] = rgba[from]; // R
        xor[to + 3] = rgba[from + 3]; // A
      }
    }
    return Buffer.concat([info, xor, Buffer.alloc(maskRow * size)]);
  });
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size }, i) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(frames[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += frames[i].length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...frames]);
}

export const TRAY_ICO_SIZES = [16, 20, 24, 32, 48];

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
  // The logo alone (no plate) for the sidebar of the app window; the renderer inlines it into its bundle.
  write('src/renderer/src/assets/mini-summa-logo.png', encodeLogoPng(96, renderLogoOnly(96)));
  write('resources/tray.ico', encodeIcoDib(TRAY_ICO_SIZES.map((size) => ({ size, rgba: drawMark(size) }))));
}
