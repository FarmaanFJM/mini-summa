#!/usr/bin/env node
// Starts Vite for the renderer, opens it with the in-memory demo core (?demo=1) in Playwright's Chromium and writes
// screenshots to docs/screenshots. Run from anywhere:
//
//   node apps/desktop/scripts/screenshots.mjs [--only name,name] [--out <dir>]
//
// The embedded ChatGPT view is simulated by a plain rectangle that obeys the same bounds and overlay calls as the real
// one, so a screenshot of an open dialog also shows that the view got out of its way.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const repo = join(desktop, '../..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outDir = flag('--out') ?? join(repo, 'docs/screenshots');
const only = flag('--only')?.split(',');

const LANDSCAPE = [1440, 900];
const PORTRAIT = [900, 1200];

// ------------------------------------------------------------------------------------------------ helpers

async function launch() {
  try {
    return await chromium.launch({ args: ['--no-sandbox'] });
  } catch (error) {
    // The Playwright library and the preinstalled browser can be different revisions; use whatever is installed.
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    const found = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
    for (const dir of found) {
      const executablePath = join(base, dir, 'chrome-linux64', 'chrome');
      if (existsSync(executablePath)) return chromium.launch({ executablePath, args: ['--no-sandbox'] });
    }
    throw error;
  }
}

async function open(page, query = '?demo=1', { terminal = true } = {}) {
  await page.goto(`${page.baseUrl}/${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector('.ms-shell', { timeout: 15_000 });
  if (terminal) {
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('Running tests'), null, { timeout: 15_000 });
  }
  await page.waitForTimeout(250);
}

const settle = (page, ms = 320) => page.waitForTimeout(ms);
const menuItem = (page, name) => page.getByRole('menuitem', { name });

/** The sidebar button that selects a project (its name starts with the project name; the actions button starts with "Actions"). */
const projectButton = (page, name) => page.getByRole('button', { name: new RegExp(`^${name}(,|$)`) });

async function openProjectMenu(page, project) {
  await page.getByRole('button', { name: `Actions for ${project}` }).first().click();
  await settle(page, 200);
}

// ------------------------------------------------------------------------------------------------ the shots

const shots = [
  { name: '01-workspace-landscape', size: LANDSCAPE },
  { name: '02-workspace-portrait', size: PORTRAIT },
  ...[['03-project-dialog-landscape', LANDSCAPE], ['04-project-dialog-portrait', PORTRAIT]].map(([name, size]) => ({
    name, size,
    async run(page) {
      await openProjectMenu(page, 'GitManager');
      await menuItem(page, 'Edit project').click();
      await page.getByRole('dialog', { name: /Edit GitManager/ }).waitFor();
      await settle(page);
    },
  })),
  ...[['05-modal-landscape', LANDSCAPE], ['06-modal-portrait', PORTRAIT]].map(([name, size]) => ({
    name, size,
    async run(page) {
      await openProjectMenu(page, 'Trading dashboard');
      await menuItem(page, 'Delete project').click();
      await page.getByRole('alertdialog').waitFor();
      await settle(page);
    },
  })),
  {
    name: '07-observed-session', size: LANDSCAPE,
    async run(page) {
      await page.getByRole('button', { name: 'Sessions', exact: true }).click();
      await menuItem(page, /d4e5f6a1/).click();
      await page.getByRole('heading', { name: 'Observed session' }).waitFor();
      await settle(page, 200);
    },
  },
  {
    name: '08-new-session-menu', size: LANDSCAPE,
    async run(page) {
      await projectButton(page, 'Atlas API').click();
      await page.getByRole('button', { name: 'New or resumed session' }).click();
      await settle(page, 250);
    },
  },
  {
    name: '09-project-menu', size: LANDSCAPE,
    async run(page) { await openProjectMenu(page, 'Atlas API'); },
  },
  {
    name: '10-exited-session', size: LANDSCAPE,
    async run(page) {
      await projectButton(page, 'Trading dashboard').click();
      await page.getByRole('tab', { name: /9f8e7d6c/ }).click().catch(() => {});
      await settle(page, 500);
    },
  },
  {
    name: '11-external-chatgpt', size: LANDSCAPE, query: '?demo=1&native=none',
  },
  { name: '12-empty-first-run', size: LANDSCAPE, query: '?demo=1&scenario=empty', terminal: false },
  { name: '13-loading', size: LANDSCAPE, query: '?demo=1&scenario=loading', terminal: false, waitFor: 'skeleton' },
  { name: '14-offline-first-connect', size: LANDSCAPE, query: '?demo=1&scenario=offline', terminal: false },
  { name: '15-load-error', size: LANDSCAPE, query: '?demo=1&scenario=error', terminal: false },
  {
    name: '16-reconnecting', size: LANDSCAPE,
    async run(page) {
      await page.evaluate(() => window.__minisummaDemo.setOffline(true));
      await page.getByText('Connection to Mini-Summa lost. Reconnecting.').waitFor();
      await settle(page, 300);
    },
  },
  {
    name: '17-settings-replaces-sidebar', size: LANDSCAPE,
    async run(page) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
      await settle(page, 250);
    },
  },
  {
    name: '18-sidebar-collapsed', size: LANDSCAPE,
    async run(page) {
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await settle(page, 400);
    },
  },
  {
    name: '19-claude-maximized', size: LANDSCAPE,
    async run(page) {
      await page.getByRole('button', { name: 'Maximize Claude pane' }).click();
      await settle(page, 400);
    },
  },
  {
    name: '20-new-project-dialog', size: LANDSCAPE,
    async run(page) {
      await page.getByRole('button', { name: 'New project' }).click();
      const dialog = page.getByRole('dialog', { name: 'New project' });
      await dialog.waitFor();
      await dialog.getByLabel('Name').fill('Billing service');
      await dialog.getByLabel('GitHub repository').fill('https://github.com/acme/billing-service.git');
      await dialog.getByLabel('Add a folder').fill('/home/me/billing');
      await dialog.getByLabel('Add a conversation').fill('https://chatgpt.com/g/g-p-6720aa11/project');
      await settle(page, 400);
    },
  },
];

// ------------------------------------------------------------------------------------------------ run

mkdirSync(outDir, { recursive: true });
const server = await createServer({ configFile: join(desktop, 'vite.renderer.config.ts'), server: { port: 0 }, logLevel: 'error' });
await server.listen();
const baseUrl = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launch();
const problems = [];
try {
  for (const shot of shots) {
    if (only && !only.includes(shot.name)) continue;
    const [width, height] = shot.size;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.baseUrl = baseUrl;
    page.on('pageerror', (e) => problems.push(`${shot.name}: page error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`${shot.name}: console error: ${m.text()}`); });
    await open(page, shot.query ?? '?demo=1', { terminal: shot.terminal !== false });
    if (shot.run) await shot.run(page);
    const file = join(outDir, `${shot.name}-${width}x${height}.png`);
    await page.screenshot({ path: file });
    console.log(`wrote ${file}`);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (problems.length) {
  console.error(`\n${problems.length} problem(s) while taking screenshots:\n${problems.join('\n')}`);
  process.exitCode = 1;
}
