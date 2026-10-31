#!/usr/bin/env node
// Starts Vite for the renderer, opens it with the in-memory demo core (?demo=1) in Playwright's Chromium and writes
// screenshots to docs/screenshots: the shell, the sidebar and its states, the quick switcher and the first-run screens in four
// windows (1440x900, 1280x720, the smallest at 960x600, and tall at 900x1200), the rest in the first. The workspace and project
// dialog screens are written too with --also-workspace. Run from anywhere:
//
//   node apps/desktop/scripts/screenshots.mjs [--only name,name] [--out <dir>] [--also-workspace]
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
const alsoWorkspace = args.includes('--also-workspace');

// The four windows every screen of the shell is looked at in: a desktop, a laptop, the smallest window, and a tall one.
const LANDSCAPE = [1440, 900];
const LAPTOP = [1280, 720];
const MINIMUM = [960, 600];
const PORTRAIT = [900, 1200];
const ALL = [LANDSCAPE, LAPTOP, MINIMUM, PORTRAIT];

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

/**
 * The shell: the page, the sidebar and its states, the quick switcher, the first-run and loading screens, and the dialogs the sidebar opens.
 * The key ones in all four windows, the rest in the desktop window. Names are shell-<name>-<width>x<height>.png.
 */
const shots = [
  { name: 'shell-workspace', sizes: ALL },
  {
    name: 'shell-sidebar-collapsed', sizes: ALL,
    async run(page) {
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await page.getByRole('button', { name: 'Expand sidebar' }).waitFor();
      await page.mouse.move(page.viewportSize().width / 2, page.viewportSize().height - 2); // out of the way: the header now sits where the button was
      await settle(page, 400);
    },
  },
  {
    name: 'shell-quick-switcher', sizes: ALL,
    async run(page) {
      await page.keyboard.press('Control+Shift+P');
      await page.getByRole('dialog', { name: 'Switch project' }).waitFor();
      await page.keyboard.press('ArrowDown');
      await settle(page, 350);
    },
  },
  {
    name: 'shell-quick-switcher-filtered', sizes: [LANDSCAPE],
    async run(page) {
      await page.getByRole('button', { name: 'Search projects' }).click();
      await page.getByRole('combobox', { name: 'Search projects' }).fill('acme');
      await page.keyboard.press('ArrowDown');
      await settle(page, 350);
    },
  },
  {
    name: 'shell-project-menu', sizes: [LANDSCAPE],
    async run(page) { await openProjectMenu(page, 'Atlas API'); },
  },
  {
    name: 'shell-project-hover', sizes: [LANDSCAPE],
    async run(page) {
      await projectButton(page, 'Atlas API').hover();
      await settle(page, 250);
    },
  },
  { name: 'shell-empty-first-run', sizes: ALL, query: '?demo=1&scenario=empty', terminal: false },
  { name: 'shell-loading', sizes: [LANDSCAPE], query: '?demo=1&scenario=loading', terminal: false },
  { name: 'shell-offline-first-connect', sizes: [LANDSCAPE], query: '?demo=1&scenario=offline', terminal: false },
  { name: 'shell-load-error', sizes: [LANDSCAPE], query: '?demo=1&scenario=error', terminal: false },
  {
    name: 'shell-reconnecting', sizes: [LANDSCAPE],
    async run(page) {
      await page.evaluate(() => window.__minisummaDemo.setOffline(true));
      await page.getByText('Connection to Mini-Summa lost. Reconnecting.').waitFor();
      await settle(page, 300);
    },
  },
  {
    name: 'shell-delete-project-dialog', sizes: [LANDSCAPE, PORTRAIT],
    async run(page) {
      await openProjectMenu(page, 'Trading dashboard');
      await menuItem(page, 'Delete').click();
      await page.getByRole('alertdialog').waitFor();
      await settle(page);
    },
  },
  {
    name: 'shell-archive-project-dialog', sizes: [LANDSCAPE],
    async run(page) {
      await openProjectMenu(page, 'GitManager');
      await menuItem(page, 'Archive').click();
      await page.getByRole('dialog', { name: /Archive GitManager/ }).waitFor();
      await settle(page);
    },
  },
];

/**
 * Screens that belong to the workspace and the project dialog, which have their own labels and change with them. They are kept here so one
 * script writes every picture, but they run only with --also-workspace, and whoever changes those screens keeps these steps true.
 */
const elsewhere = [
  {
    name: '03-project-settings-dialog', sizes: [LANDSCAPE, PORTRAIT],
    async run(page) {
      await openProjectMenu(page, 'GitManager');
      await menuItem(page, 'Project settings').click();
      await page.getByRole('dialog').first().waitFor();
      await settle(page);
    },
  },
  {
    name: '20-new-project-dialog', sizes: [LANDSCAPE],
    async run(page) {
      await page.getByRole('button', { name: 'New project' }).click();
      await page.getByRole('dialog', { name: 'New project' }).waitFor();
      await settle(page, 400);
    },
  },
  {
    name: '07-observed-session', sizes: [LANDSCAPE],
    async run(page) {
      await page.getByRole('button', { name: 'Sessions', exact: true }).click();
      await menuItem(page, /d4e5f6a1/).click();
      await page.getByRole('heading', { name: 'Observed session' }).waitFor();
      await settle(page, 200);
    },
  },
  {
    name: '10-exited-session', sizes: [LANDSCAPE],
    async run(page) {
      await projectButton(page, 'Trading dashboard').click();
      await page.getByRole('tab', { name: /9f8e7d6c/ }).click().catch(() => {});
      await settle(page, 500);
    },
  },
  { name: '11-external-chatgpt', sizes: [LANDSCAPE], query: '?demo=1&native=none' },
  {
    // A new session whose terminal sits on Claude's "Do you trust the files in this folder?" screen. After six seconds of
    // "Starting" the pane points the person to the terminal. Nothing types for them.
    name: '21-starting-trust-hint', sizes: [LANDSCAPE], query: '?demo=1&trust=1',
    async run(page) {
      await projectButton(page, 'Atlas API').click();
      await page.getByRole('region', { name: 'Claude', exact: true }).getByRole('button', { name: 'New session', exact: true }).click();
      await menuItem(page, 'New local session').click();
      await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('Do you trust the files'), null, { timeout: 10_000 });
      await page.getByText('Claude may be waiting for you to answer a question in the terminal').waitFor({ timeout: 12_000 });
      await settle(page, 300);
    },
  },
  {
    name: '23-lost-terminal', sizes: [LANDSCAPE],
    async run(page) {
      await projectButton(page, 'Docs site').click();
      await page.getByText(/lost its connection to this terminal/).waitFor();
      await settle(page, 300);
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
  for (const shot of [...shots, ...(alsoWorkspace ? elsewhere : [])]) {
    if (only && !only.includes(shot.name)) continue;
    for (const [width, height] of shot.sizes ?? [LANDSCAPE]) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.baseUrl = baseUrl;
      page.on('pageerror', (e) => problems.push(`${shot.name} ${width}x${height}: page error: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`${shot.name} ${width}x${height}: console error: ${m.text()}`); });
      try {
        await open(page, shot.query ?? '?demo=1', { terminal: shot.terminal !== false });
        if (shot.run) await shot.run(page);
        const file = join(outDir, `${shot.name}-${width}x${height}.png`);
        await page.screenshot({ path: file });
        console.log(`wrote ${file}`);
      } catch (error) {
        problems.push(`${shot.name} ${width}x${height}: ${error.message.split('\n')[0]}`);
        await page.screenshot({ path: join(outDir, `${shot.name}-${width}x${height}-FAILED.png`) }).catch(() => {});
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (problems.length) {
  console.error(`\n${problems.length} problem(s) while taking screenshots:\n${problems.join('\n')}`);
  process.exitCode = 1;
}
