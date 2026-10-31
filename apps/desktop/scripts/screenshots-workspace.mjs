#!/usr/bin/env node
// Screenshots of the workspace on the demo core, in Playwright's Chromium (not the real window: native views are drawn as plain
// rectangles by the demo native). Vite serves the renderer and ?demo=1 uses the in-memory core. States: a project with a repository
// and a folder, GitHub only, a linked ChatGPT Project, nothing at all, the view modes, the "+" menus, the empty Claude pane and the
// Cloud tab in its states.
//
//   node apps/desktop/scripts/screenshots-workspace.mjs [--only name,name] [--out <dir>] [--sizes 1440x900,960x600]
//
// Output: docs/screenshots/workspace-<state>-<width>x<height>.png (default sizes 1440x900 and 960x600).
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(desktop, 'package.json'));
const { chromium } = require('playwright');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outDir = flag('--out') ?? join(desktop, '../../docs/screenshots');
const only = flag('--only')?.split(',');
const sizeFilter = (flag('--sizes') ?? '1440x900,960x600').split(',');
mkdirSync(outDir, { recursive: true });

const SIZES = { '1440x900': [1440, 900], '1280x720': [1280, 720], '960x600': [960, 600], '900x1200': [900, 1200] };

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

const demo = (page, name, input) => page.evaluate(([n, i]) => window.__minisummaDemo.server.call(n, i), [name, input]);
const settle = (page, ms = 350) => page.waitForTimeout(ms);
const project = (page, name) => page.getByRole('button', { name: new RegExp(`^${name}(,|$)`) });
const claudePane = (page) => page.getByRole('region', { name: 'Claude', exact: true });

async function create(page, body) {
  const made = await demo(page, 'projects.create', { body });
  return made;
}

async function open(page, query = '?demo=1', { terminal = true } = {}) {
  await page.goto(`${page.baseUrl}/${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector('.ms-shell', { timeout: 15000 });
  if (terminal) await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('Running tests'), null, { timeout: 15000 });
  await settle(page, 300);
}

const ALL = [
  { name: 'repo-folder', note: 'GitHub repository and folder (GitManager)' },
  { name: 'github-only', note: 'GitHub-only project, no folder', async run(page) {
    await create(page, { name: 'Cloud API', githubRepo: 'acme/cloud-api', roots: [] });
    await project(page, 'Cloud API').click(); await settle(page);
  } },
  { name: 'folder-only', note: 'Folder only (Docs site)', terminal: true, async run(page) { await project(page, 'Docs site').click(); await settle(page); } },
  { name: 'linked-project', note: 'Linked ChatGPT Project, no conversations', async run(page) {
    await create(page, { name: 'Caissa trainer', chatgptProject: { url: 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-caissa-trainer/project' }, roots: [{ path: 'C:\\Dev\\caissa' }], githubRepo: 'acme/caissa' });
    await project(page, 'Caissa trainer').click(); await settle(page);
  } },
  { name: 'no-places', note: 'A project with neither folder, repository nor ChatGPT', async run(page) {
    await create(page, { name: 'Empty one', roots: [] });
    await project(page, 'Empty one').click(); await settle(page);
  } },
  { name: 'focus-chatgpt', note: 'Focus ChatGPT', async run(page) { await page.getByRole('radio', { name: 'ChatGPT' }).click(); await settle(page); } },
  { name: 'focus-claude', note: 'Focus Claude', async run(page) { await page.getByRole('radio', { name: 'Claude', exact: true }).click(); await settle(page); } },
  { name: 'plus-menu-both', note: '+ menu with a folder and a repository', async run(page) {
    await claudePane(page).getByRole('button', { name: 'New session' }).click(); await settle(page, 250);
  } },
  { name: 'plus-menu-folder-only', note: '+ menu, folder only', async run(page) {
    await project(page, 'Docs site').click(); await settle(page);
    await claudePane(page).getByRole('button', { name: 'New session' }).click(); await settle(page, 250);
  } },
  { name: 'plus-menu-github-only', note: '+ menu, repository only', async run(page) {
    await create(page, { name: 'Cloud API', githubRepo: 'acme/cloud-api', roots: [] });
    await project(page, 'Cloud API').click(); await settle(page);
    await claudePane(page).getByRole('button', { name: 'New session' }).click(); await settle(page, 250);
  } },
  { name: 'empty-claude-both', note: 'Empty Claude pane: folder and repository', async run(page) {
    await create(page, { name: 'Fresh both', githubRepo: 'acme/fresh', roots: [{ path: 'C:\\Dev\\fresh' }] });
    await project(page, 'Fresh both').click(); await settle(page);
  } },
  { name: 'empty-claude-github', note: 'Empty Claude pane: repository only', async run(page) {
    await create(page, { name: 'Cloud API', githubRepo: 'acme/cloud-api', roots: [] });
    await project(page, 'Cloud API').click(); await settle(page);
  } },
  { name: 'empty-claude-folder', note: 'Empty Claude pane: folder only', async run(page) {
    await create(page, { name: 'Local only', roots: [{ path: 'C:\\Dev\\localonly' }] });
    await project(page, 'Local only').click(); await settle(page);
  } },
  { name: 'cloud-tab', note: 'Cloud tab on the start page (demo native with a Claude Code view)', async run(page) {
    await claudePane(page).getByRole('tab', { name: /Cloud/ }).click(); await settle(page, 600);
  } },
  { name: 'cloud-session', note: 'Cloud tab on a session page', async run(page) {
    await claudePane(page).getByRole('tab', { name: /Cloud/ }).click(); await settle(page, 500);
    await page.evaluate((address) => window.__minisummaNative.claudeWeb.navigate(address), ['https://claude.ai/code', 'session_abc123'].join('/'));
    await settle(page, 700);
  } },
  { name: 'cloud-login', note: 'Cloud tab, the page asks to sign in', query: '?demo=1&claude=login', async run(page) {
    await claudePane(page).getByRole('tab', { name: /Cloud/ }).click(); await settle(page, 700);
  } },
  { name: 'cloud-blocked', note: 'Cloud tab, blocked', query: '?demo=1&claude=blocked', async run(page) {
    await claudePane(page).getByRole('tab', { name: /Cloud/ }).click(); await settle(page, 700);
  } },
  { name: 'cloud-error', note: 'Cloud tab, error', query: '?demo=1&claude=error', async run(page) {
    await claudePane(page).getByRole('tab', { name: /Cloud/ }).click(); await settle(page, 700);
  } },
  { name: 'cloud-no-host', note: 'Cloud tab where the host cannot embed it', query: '?demo=1&claude=none', async run(page) {
    await claudePane(page).getByRole('tab', { name: /Cloud/ }).click(); await settle(page, 400);
  } },
  { name: 'cloud-no-host-browser', note: 'Browser without any native host', query: '?demo=1&native=none', terminal: true, async run(page) {
    await claudePane(page).getByRole('tab', { name: /Cloud/ }).click(); await settle(page, 400);
  } },
  { name: 'cloud-focus-claude', note: 'Cloud tab with Claude focused', async run(page) {
    await claudePane(page).getByRole('tab', { name: /Cloud/ }).click(); await settle(page, 500);
    await page.getByRole('radio', { name: 'Claude', exact: true }).click(); await settle(page, 500);
  } },
  { name: 'keyboard-focus', note: 'Keyboard focus on the chosen view option', async run(page) {
    await page.getByRole('radio', { name: 'Split' }).focus(); await page.keyboard.press('ArrowRight'); await settle(page, 500);
  }, keepPointer: true },
  { name: 'hover-place', note: 'Pointer on the repository in the header', async run(page) {
    await page.getByRole('button', { name: /Open acme\/git-manager on GitHub/ }).hover(); await settle(page, 800);
  }, keepPointer: true },
  { name: 'tooltip-view', note: 'Tooltip on the view switch', async run(page) {
    await page.getByRole('radio', { name: 'ChatGPT' }).hover(); await settle(page, 700);
  } },
  { name: 'external-chatgpt', note: 'ChatGPT in external mode with a linked project', query: '?demo=1&native=none', terminal: true, async run(page) {
    await create(page, { name: 'Caissa trainer', chatgptProject: { url: 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-caissa-trainer/project' }, roots: [] });
    await project(page, 'Caissa trainer').click(); await settle(page);
  } },
  { name: 'long-name', note: 'Very long project name and path', async run(page) {
    await create(page, { name: 'Trading platform migration for the Atlas payments gateway and the settlement engine', githubRepo: 'acme/atlas-payments-gateway-settlement-engine', roots: [{ path: 'C:\\Dev\\Work\\Clients\\Atlas\\Payments\\gateway-settlement-engine-monorepo' }] });
    await page.getByRole('button', { name: /^Trading platform migration/ }).click(); await settle(page);
  } },
];

const server = await createServer({ configFile: join(desktop, 'vite.renderer.config.ts'), server: { port: 0 }, logLevel: 'error' });
await server.listen();
const baseUrl = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await launch();
const problems = [];
try {
  for (const shot of ALL) {
    if (only && !only.includes(shot.name)) continue;
    for (const [label, [width, height]] of Object.entries(SIZES)) {
      if (sizeFilter && !sizeFilter.includes(label)) continue;
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.baseUrl = baseUrl;
      page.on('pageerror', (e) => problems.push(`${shot.name} ${label}: page error: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`${shot.name} ${label}: console error: ${m.text()}`); });
      try {
        await open(page, shot.query ?? '?demo=1', { terminal: shot.terminal !== false });
        if (shot.run) await shot.run(page);
        if (!shot.keepPointer) { await page.mouse.move(2, 2); await settle(page, 450); }
        await page.screenshot({ path: join(outDir, `workspace-${shot.name}-${label}.png`) });
        console.log(`wrote ${shot.name}-${label}.png`);
      } catch (e) {
        problems.push(`${shot.name} ${label}: ${e.message.split('\n')[0]}`);
        try { await page.screenshot({ path: join(outDir, `FAILED-workspace-${shot.name}-${label}.png`) }); } catch { /* ignore */ }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
if (problems.length) { console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`); process.exitCode = 1; }
