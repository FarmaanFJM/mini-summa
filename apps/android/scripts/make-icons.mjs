// One-off generator for assets/icons/*.png. The app uses only icons from the vendored Summa-UI catalog
// (third_party/summa-ui-guidance/icons, Lucide, ISC). They are rasterized white-on-transparent at 24dp for three
// densities and tinted at runtime, so the app needs no SVG runtime dependency.
//
//   npm install --no-save @resvg/resvg-js   (in a scratch folder; it is not an app dependency)
//   RESVG_MODULE=/path/to/node_modules/@resvg/resvg-js/index.js node scripts/make-icons.mjs
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = resolve(here, '../../../third_party/summa-ui-guidance/icons');
const out = resolve(here, '../assets/icons');
const { Resvg } = await import(pathToFileURL(process.env.RESVG_MODULE ?? '@resvg/resvg-js').href);

const NAMES = [
  'home', 'activity', 'inbox', 'file-text', 'settings', 'chevron-right', 'filter', 'more-v', 'x', 'copy', 'share', 'external',
  'check', 'send', 'refresh', 'circle-alert', 'circle-check', 'triangle-alert', 'info', 'wifi', 'smartphone', 'key', 'bell',
  'terminal', 'lock', 'log-out',
];

mkdirSync(out, { recursive: true });
for (const name of NAMES) {
  const svg = readFileSync(join(catalog, 'svg', `${name}.svg`), 'utf8').replace(/currentColor/g, '#ffffff');
  for (const [suffix, px] of [['', 24], ['@2x', 48], ['@3x', 72]]) {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: px } }).render().asPng();
    writeFileSync(join(out, `${name}${suffix}.png`), png);
  }
}
copyFileSync(join(catalog, 'LICENSE'), join(out, 'LICENSE'));
writeFileSync(join(out, 'names.json'), `${JSON.stringify(NAMES, null, 2)}\n`);
console.log(`wrote ${NAMES.length} icons x 3 densities to ${out}`);
