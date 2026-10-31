#!/usr/bin/env node
// Screenshots of the project dialogs on the demo core, in Playwright's Chromium. Usage:
//   node projects-shots.mjs [--only name,name] [--out dir] [--sizes 1440x900,960x600]
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run from apps/desktop/scripts it finds the app next to itself; from anywhere else it uses the checkout it was written against.
const here = fileURLToPath(new URL('.', import.meta.url));
const desktop = here.replace(/\/$/, '').endsWith('apps/desktop/scripts') ? join(here, '..') : '/home/user/mini-summa/apps/desktop';
const require = createRequire(join(desktop, 'package.json'));
const { chromium } = require('playwright');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outDir = flag('--out') ?? join(desktop, '../../docs/screenshots');
const only = flag('--only')?.split(',');
const sizes = (flag('--sizes') ?? '1440x900,960x600').split(',').map((s) => s.split('x').map(Number));

async function launch() {
  try { return await chromium.launch({ args: ['--no-sandbox'] }); } catch (error) {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    const found = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
    for (const dir of found) {
      const executablePath = join(base, dir, 'chrome-linux64', 'chrome');
      if (existsSync(executablePath)) return chromium.launch({ executablePath, args: ['--no-sandbox'] });
    }
    throw error;
  }
}

const settle = (page, ms = 350) => page.waitForTimeout(ms);

async function open(page, query = '?demo=1') {
  await page.goto(`${page.baseUrl}/${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector('.ms-shell', { timeout: 15_000 });
  await page.waitForTimeout(500);
}

const demo = (page, source, arg) => page.evaluate(async ([src, a]) => {
  // eslint-disable-next-line no-new-func
  return new Function('server', 'arg', `return (${src})(server, arg);`)(window.__minisummaDemo.server, a);
}, [source.toString(), arg]);

async function openNew(page) {
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.waitFor();
  return dialog;
}

async function openSettings(page, name) {
  await page.getByRole('button', { name: `Actions for ${name}` }).first().click();
  await page.getByRole('menuitem', { name: /^(Edit project|Project settings|Settings)$/ }).click();
  const dialog = page.getByRole('dialog', { name: `${name} settings` });
  await dialog.waitFor();
  return dialog;
}

const ADDRESS = 'https://chatgpt.com/g/g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer/project';

const shots = [
  {
    name: 'projects-new-chatgpt',
    async run(page) {
      const d = await openNew(page);
      await d.getByLabel('Address of an existing ChatGPT Project').fill(ADDRESS);
      await settle(page);
    },
  },
  {
    name: 'projects-new-chatgpt-error',
    async run(page) {
      const d = await openNew(page);
      await d.getByLabel('Address of an existing ChatGPT Project').fill('https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      await settle(page);
    },
  },
  {
    name: 'projects-new-github',
    async run(page) {
      const d = await openNew(page);
      await d.getByRole('tab', { name: 'GitHub repository' }).click();
      await d.getByLabel('Repository', { exact: true }).fill('https://github.com/FarmaanFIM/CaissaTrainer.git');
      await settle(page);
    },
  },
  {
    name: 'projects-new-folder',
    async run(page) {
      const d = await openNew(page);
      await d.getByRole('tab', { name: 'Local folder' }).click();
      await d.getByLabel('Folder', { exact: true }).fill('C:\\Dev\\Billing service');
      await settle(page);
    },
  },
  {
    name: 'projects-new-folder-wsl',
    async run(page) {
      const d = await openNew(page);
      await d.getByRole('tab', { name: 'Local folder' }).click();
      await d.getByLabel('Folder', { exact: true }).fill('/home/me/billing');
      await settle(page);
    },
  },
  {
    name: 'projects-new-empty',
    async run(page) {
      const d = await openNew(page);
      await d.getByRole('tab', { name: 'Empty project' }).click();
      await settle(page);
    },
  },
  {
    name: 'projects-settings-github-only',
    async run(page) {
      await demo(page, (server) => server.call('projects.create', { body: { name: 'CaissaTrainer', githubRepo: 'FarmaanFIM/CaissaTrainer' } }));
      await settle(page, 250);
      await openSettings(page, 'CaissaTrainer');
      await settle(page);
    },
  },
  {
    name: 'projects-settings-linked',
    async run(page) {
      await demo(page, async (server, address) => {
        const p = await server.call('projects.create', {
          body: { name: 'CaissaTrainer', githubRepo: 'FarmaanFIM/CaissaTrainer', chatgptProject: { url: address }, roots: [{ path: 'C:\\Dev\\CaissaTrainer', env: 'win' }] },
        });
        await server.call('conversations.add', { params: { id: p.id }, body: { url: 'https://chatgpt.com/g/g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Opening theory review' } });
      }, ADDRESS);
      await settle(page, 250);
      await openSettings(page, 'CaissaTrainer');
      await settle(page);
    },
  },
  {
    name: 'projects-settings-saved',
    async run(page) {
      await demo(page, (server) => server.call('projects.create', { body: { name: 'CaissaTrainer', githubRepo: 'FarmaanFIM/CaissaTrainer' } }));
      await settle(page, 250);
      const d = await openSettings(page, 'CaissaTrainer');
      const folder = d.getByLabel('Folder path');
      await folder.fill('C:\\Dev\\CaissaTrainer');
      await d.getByRole('button', { name: 'Add folder', exact: true }).click();
      await d.getByRole('list', { name: 'Local folders' }).waitFor();
      await d.getByText('Saved').first().waitFor();
      await page.waitForTimeout(150);
    },
  },
  {
    name: 'projects-settings-error',
    async run(page) {
      await demo(page, async (server) => {
        server.folderCheck = (env, path) => (/missing/i.test(path) ? { code: 'root_not_found', message: `This folder does not exist: ${path}. Check the spelling, or choose it with Browse.` } : null);
        await server.call('projects.create', { body: { name: 'CaissaTrainer', githubRepo: 'FarmaanFIM/CaissaTrainer' } });
      });
      await settle(page, 250);
      const d = await openSettings(page, 'CaissaTrainer');
      await d.getByLabel('Folder path').fill('C:\\Dev\\missing\\Caissa');
      await d.getByRole('button', { name: 'Add folder', exact: true }).click();
      await d.getByText(/does not exist/).waitFor();
      await d.getByLabel('GitHub repository', { exact: true }).fill('not a repo');
      await settle(page);
    },
  },
];

mkdirSync(outDir, { recursive: true });
const server = await createServer({ configFile: join(desktop, 'vite.renderer.config.ts'), server: { port: 0 }, logLevel: 'error' });
await server.listen();
const baseUrl = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launch();
const problems = [];
try {
  for (const shot of shots) {
    if (only && !only.includes(shot.name)) continue;
    for (const [width, height] of sizes) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.baseUrl = baseUrl;
      page.on('pageerror', (e) => problems.push(`${shot.name} ${width}x${height}: page error: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`${shot.name} ${width}x${height}: console error: ${m.text()}`); });
      try {
        await open(page, shot.query ?? '?demo=1');
        await shot.run(page);
        const file = join(outDir, `${shot.name}-${width}x${height}.png`);
        await page.screenshot({ path: file });
        console.log(`wrote ${file}`);
      } catch (error) {
        problems.push(`${shot.name} ${width}x${height}: ${error.message.split('\n')[0]}`);
        await page.screenshot({ path: join(outDir, `FAILED-${shot.name}-${width}x${height}.png`) }).catch(() => {});
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exitCode = 1;
}
