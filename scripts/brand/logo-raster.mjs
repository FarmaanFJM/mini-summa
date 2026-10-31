// The Mini-Summa logo (assets/brand/mini-summa-logo.png: an owl whose eyes are an infinity sign, in jade and charcoal feathers)
// turned into the icons every app needs, with nothing but node:zlib: no image library, no external tool. Deterministic: the same
// logo gives the same bytes on every machine, which the packaging tests rely on.
//
//   renderBrandMark(size)   RGBA pixels of the app icon: the logo on a charcoal rounded square (taskbar, installer, tray, extension)
//   renderLogoOnly(size)    RGBA pixels of the logo alone on transparent (Android adaptive icon foreground, in-app mark)
//   renderSilhouette(size)  white-on-transparent shape of the logo (Android notification icon, which the system tints)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
export const LOGO_FILE = path.resolve(here, '../../assets/brand/mini-summa-logo.png');

// Plate colours: the Summa-UI charcoal tokens (--s0/--s1/--s3), as the previous mark used.
const CHARCOAL_TOP = [0x1b, 0x1c, 0x1c];
const CHARCOAL_BOTTOM = [0x14, 0x15, 0x15];
const EDGE = [0x2c, 0x2d, 0x2d];

// ---- PNG decoding (8-bit RGBA or RGB, no interlace: what the logo file is) --------------------------------------------

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8; let width = 0; let height = 0; let depth = 0; let type = 0; let interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (type !== 6 && type !== 2)) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const bpp = type === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = (line[x] + add) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      rgba[o] = line[x * bpp]; rgba[o + 1] = line[x * bpp + 1]; rgba[o + 2] = line[x * bpp + 2]; rgba[o + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { width, height, rgba };
}

// ---- the logo, cropped to its visible part and made square ------------------------------------------------------------

let cached = null;

/** Premultiplied float RGBA of the logo, cropped to where it is visible, centred in a square. */
export function loadLogo(file = LOGO_FILE) {
  if (cached && cached.file === file) return cached.logo;
  const { width, height, rgba } = decodePng(fs.readFileSync(file));
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] > 16) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  if (maxX < 0) throw new Error('the logo has no visible pixels');
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const side = Math.max(w, h);
  const ox = Math.floor((side - w) / 2);
  const oy = Math.floor((side - h) / 2);
  const data = new Float64Array(side * side * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const s = ((minY + y) * width + (minX + x)) * 4;
      const a = rgba[s + 3] / 255;
      const d = ((oy + y) * side + (ox + x)) * 4;
      data[d] = (rgba[s] / 255) * a; data[d + 1] = (rgba[s + 1] / 255) * a; data[d + 2] = (rgba[s + 2] / 255) * a; data[d + 3] = a;
    }
  }
  const logo = { side, data };
  cached = { file, logo };
  return logo;
}

/** The logo scaled to `size` x `size` by averaging the source area under each pixel (premultiplied, so edges stay clean). */
export function scaleLogo(size, logo = loadLogo()) {
  const { side, data } = logo;
  const out = new Float64Array(size * size * 4);
  const step = side / size;
  for (let dy = 0; dy < size; dy += 1) {
    const y0 = dy * step; const y1 = y0 + step;
    for (let dx = 0; dx < size; dx += 1) {
      const x0 = dx * step; const x1 = x0 + step;
      let r = 0; let g = 0; let b = 0; let a = 0; let weight = 0;
      for (let sy = Math.floor(y0); sy < Math.min(side, Math.ceil(y1)); sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.min(side, Math.ceil(x1)); sx += 1) {
          const w = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const i = (sy * side + sx) * 4;
          r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w; a += data[i + 3] * w; weight += w;
        }
      }
      const o = (dy * size + dx) * 4;
      out[o] = r / weight; out[o + 1] = g / weight; out[o + 2] = b / weight; out[o + 3] = a / weight;
    }
  }
  return out;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

function roundedRectSdf(x, y, size, radius) {
  const h = size / 2;
  const qx = Math.abs(x - h) - (h - radius);
  const qy = Math.abs(y - h) - (h - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** The logo (premultiplied) placed in a size x size canvas at `fill` of its width, centred. */
function placeLogo(size, fill) {
  const inner = Math.max(1, Math.round(size * fill));
  const scaled = scaleLogo(inner);
  const canvas = new Float64Array(size * size * 4);
  const off = Math.floor((size - inner) / 2);
  for (let y = 0; y < inner; y += 1) {
    for (let x = 0; x < inner; x += 1) {
      const s = (y * inner + x) * 4;
      const d = ((off + y) * size + (off + x)) * 4;
      canvas[d] = scaled[s]; canvas[d + 1] = scaled[s + 1]; canvas[d + 2] = scaled[s + 2]; canvas[d + 3] = scaled[s + 3];
    }
  }
  return canvas;
}

/** How much of the icon the logo fills: small icons need it larger to stay readable. */
const fillFor = (size) => (size <= 32 ? 0.94 : size <= 64 ? 0.9 : 0.84);

/** App icon: the logo on a charcoal rounded square, RGBA bytes (straight alpha), top-down. */
export function renderBrandMark(size) {
  const logo = placeLogo(size, fillFor(size));
  const out = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const edge = Math.max(1, size / 64);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cx = x + 0.5; const cy = y + 0.5;
      const body = clamp01(0.5 - roundedRectSdf(cx, cy, size, radius));
      const t = cy / size;
      const inside = -roundedRectSdf(cx, cy, size, radius);
      const edgeMix = clamp01(1 - inside / edge) * 0.9;
      const plate = [0, 1, 2].map((k) => {
        const base = CHARCOAL_TOP[k] + (CHARCOAL_BOTTOM[k] - CHARCOAL_TOP[k]) * t;
        return base + (EDGE[k] - base) * edgeMix;
      });
      const l = (y * size + x) * 4;
      const la = logo[l + 3];
      const o = l;
      for (let k = 0; k < 3; k += 1) out[o + k] = Math.round(logo[l + k] * 255 + plate[k] * (1 - la));
      out[o + 3] = Math.round(body * 255);
    }
  }
  return out;
}

/** Launcher icon: the logo on a full-bleed charcoal square (the system applies its own mask), RGBA bytes. */
export function renderBrandSquare(size, fill = 0.74) {
  const logo = placeLogo(size, fill);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const t = (y + 0.5) / size;
    for (let x = 0; x < size; x += 1) {
      const l = (y * size + x) * 4;
      const la = logo[l + 3];
      for (let k = 0; k < 3; k += 1) out[l + k] = Math.round(logo[l + k] * 255 + (CHARCOAL_TOP[k] + (CHARCOAL_BOTTOM[k] - CHARCOAL_TOP[k]) * t) * (1 - la));
      out[l + 3] = 255;
    }
  }
  return out;
}

/** The logo alone on a transparent square (straight alpha). `fill` is the share of the width it takes. */
export function renderLogoOnly(size, fill = 1) {
  const logo = placeLogo(size, fill);
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const a = logo[i * 4 + 3];
    if (a > 0) for (let k = 0; k < 3; k += 1) out[i * 4 + k] = Math.round(clamp01(logo[i * 4 + k] / a) * 255);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

/** White where the logo is, transparent elsewhere (a status-bar icon: the system colours it). */
export function renderSilhouette(size, fill = 0.92) {
  const logo = placeLogo(size, fill);
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = 255; out[i * 4 + 1] = 255; out[i * 4 + 2] = 255;
    out[i * 4 + 3] = Math.round(clamp01(logo[i * 4 + 3] * 1.15) * 255);
  }
  return out;
}

// ---- PNG encoding -----------------------------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};

/** A complete PNG file from top-down RGBA bytes. */
export function encodePng(size, rgba) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) { rows[y * (size * 4 + 1)] = 0; rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
