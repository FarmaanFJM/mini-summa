// Writes the Android launcher, adaptive-icon foreground and notification icons from the Mini-Summa logo
// (assets/brand/mini-summa-logo.png), with nothing but node:zlib. Deterministic. Usage: node scripts/make-brand-icons.mjs
//   assets/icon.png               1024  the logo on a full-bleed charcoal square (the system applies its mask)
//   assets/adaptive-icon.png      1024  the logo alone on transparent, inside the adaptive icon's safe zone (the background colour
//                                       #141515 comes from app.config.ts)
//   assets/notification-icon.png    96  white silhouette of the logo; Android tints it (expo-notifications, color #10b981)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, renderBrandSquare, renderLogoOnly, renderSilhouette } from '../../../scripts/brand/logo-raster.mjs';

const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../assets');
mkdirSync(assets, { recursive: true });
const files = [
  ['icon.png', 1024, renderBrandSquare(1024)],
  ['adaptive-icon.png', 1024, renderLogoOnly(1024, 0.6)],
  ['notification-icon.png', 96, renderSilhouette(96)],
];
for (const [name, size, rgba] of files) {
  const png = encodePng(size, rgba);
  writeFileSync(join(assets, name), png);
  console.log(`assets/${name}  ${size}x${size}  ${png.length} bytes`);
}
