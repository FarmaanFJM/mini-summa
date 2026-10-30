#!/usr/bin/env node
// Screenshots of the reports, activity, settings and onboarding screens, taken the same way as scripts/screenshots.mjs:
// Vite serves the renderer, Chromium opens it with the in-memory demo core (?demo=1), and the feature scene (a long report,
// code fences, unmarked messages, a phone prompt, a longer feed) is added to the running core so the page updates live.
//
//   node apps/desktop/scripts/screenshots-features.mjs [--only name,name] [--out <dir>]
//
// Output: docs/screenshots/features-<name>-1440x900.png
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
const SIZE = [1440, 900];

// ------------------------------------------------------------------------------------------------ helpers

async function launch() {
  try {
    return await chromium.launch({ args: ['--no-sandbox'] });
  } catch (error) {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    const found = existsSync(base) ? readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : [];
    for (const dir of found) {
      const executablePath = join(base, dir, 'chrome-linux64', 'chrome');
      if (existsSync(executablePath)) return chromium.launch({ executablePath, args: ['--no-sandbox'] });
    }
    throw error;
  }
}

const settle = (page, ms = 320) => page.waitForTimeout(ms);

/** Opens the demo core. `scene` adds the feature scenario (more reports, a longer feed, a phone prompt). */
async function open(page, { query = '?demo=1', scene = true, terminal = false } = {}) {
  await page.goto(`${page.baseUrl}/${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector('.ms-shell', { timeout: 15_000 });
  if (terminal) await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('Running tests'), null, { timeout: 15_000 });
  if (scene) {
    await page.waitForFunction(() => Boolean(window.__minisummaDemo), null, { timeout: 15_000 });
    await page.evaluate(async () => {
      const seed = await import('/src/dev/demo/features-seed.ts');
      seed.applyFeatureScenario(window.__minisummaDemo.server);
    });
  }
  await settle(page, 400);
}

/** Runs code in the page against the demo core and its feature state (clipboard path, tailscale status, failures, ...). */
const withDemo = (page, fn, arg) => page.evaluate(async ([source, argument]) => {
  const handlers = await import('/src/dev/demo/features-handlers.ts');
  const server = window.__minisummaDemo.server;
  // eslint-disable-next-line no-new-func
  return new Function('handlers', 'server', 'arg', `return (${source})(handlers, server, arg);`)(handlers, server, argument);
}, [fn.toString(), arg]);

const nav = (page, name) => page.getByRole('button', { name: new RegExp(`^${name}`) }).first();

async function goReports(page, title) {
  await nav(page, 'Reports').click();
  await page.getByRole('list', { name: 'Reports' }).waitFor();
  if (title) await page.getByRole('button', { name: new RegExp(title) }).first().click();
  await settle(page, 450);
}

const sections = (page) => page.getByRole('navigation', { name: 'Settings sections' });

/** Opens Settings (which takes over the sidebar) and, if given, one of its sections. */
async function goSettings(page, section) {
  await nav(page, 'Settings').click();
  await sections(page).waitFor();
  if (section) await sections(page).getByRole('button', { name: section, exact: true }).click();
  await settle(page, 450);
}

const scrollTo = async (locator) => { await locator.scrollIntoViewIfNeeded(); await settle(locator.page(), 250); };

// ------------------------------------------------------------------------------------------------ the shots

const shots = [
  {
    name: 'reports-queue',
    async run(page) {
      await goReports(page);
      await page.getByRole('button', { name: /^Waiting for handoff/ }).click();
      await settle(page, 250);
    },
  },
  {
    name: 'report-awaiting-send',
    async run(page) { await goReports(page, 'Add branch protection checks'); },
  },
  {
    name: 'report-ready-fenced',
    async run(page) { await goReports(page, 'Make the release script fail fast'); },
  },
  {
    name: 'report-multipart',
    async run(page) {
      await goReports(page, 'Move the clone pipeline');
      await page.getByRole('button', { name: 'Copy part 1 of 3 and open' }).click();
      await page.getByRole('button', { name: 'Copy part 2 of 3 and open' }).waitFor();
      await settle(page, 300);
    },
  },
  {
    name: 'report-sent-review',
    async run(page) { await goReports(page, 'Upgrade libgit2'); },
  },
  {
    name: 'followup-composer',
    async run(page) {
      await goReports(page, 'Upgrade libgit2');
      await page.getByRole('button', { name: 'I have read the review' }).click();
      await page.getByRole('button', { name: 'Write a follow-up for Claude' }).click();
      await page.getByRole('textbox', { name: 'Feedback for Claude' }).fill('The second backoff test still reads the wall clock. Use the fake clock there too, then run the suite on Linux and report the slowest five tests.');
      await page.getByRole('radio', { name: /session e5f6a7b8/ }).check();
      await page.getByRole('button', { name: 'Inspect exact text' }).click();
      await settle(page, 300);
    },
  },
  {
    name: 'followup-confirm',
    async run(page) {
      await goReports(page, 'Upgrade libgit2');
      await page.getByRole('button', { name: 'I have read the review' }).click();
      await page.getByRole('button', { name: 'Write a follow-up for Claude' }).click();
      await page.getByRole('textbox', { name: 'Feedback for Claude' }).fill('The second backoff test still reads the wall clock. Use the fake clock there too, then run the suite on Linux and report the slowest five tests.');
      await page.getByRole('radio', { name: /session e5f6a7b8/ }).check();
      await page.getByRole('button', { name: 'Inspect exact text' }).click();
      await page.getByRole('region', { name: 'Review' }).getByRole('button', { name: 'Send to Claude' }).click();
      await page.getByRole('dialog').waitFor();
      await settle(page, 300);
    },
  },
  {
    name: 'other-final-messages',
    async run(page) {
      await goReports(page);
      await page.getByRole('tab', { name: /Other messages/ }).click();
      await page.getByRole('list', { name: 'Other final messages' }).getByRole('button').first().click();
      await settle(page, 400);
    },
  },
  {
    name: 'activity-feed',
    async run(page) {
      await nav(page, 'Activity').click();
      await page.getByRole('feed', { name: 'Activity feed' }).waitFor();
      await settle(page, 400);
    },
  },
  {
    name: 'activity-needs-you',
    async run(page) {
      await nav(page, 'Activity').click();
      await page.getByRole('tab', { name: /^Needs you/ }).click();
      await page.getByRole('list', { name: 'Waiting for your approval' }).waitFor();
      await settle(page, 400);
    },
  },
  {
    name: 'activity-notifications',
    async run(page) {
      await nav(page, 'Activity').click();
      await page.getByRole('tab', { name: 'Notifications' }).click();
      await page.getByRole('list', { name: /^Notifications, / }).first().waitFor();
      await settle(page, 400);
    },
  },

  // ---- settings
  {
    name: 'settings-chatgpt',
    async run(page) { await goSettings(page, 'ChatGPT'); },
  },
  {
    name: 'settings-claude-code',
    async run(page) {
      await goSettings(page, 'Claude Code');
      await page.getByRole('list', { name: 'Environments' }).waitFor();
      await settle(page, 300);
    },
  },
  {
    name: 'settings-hooks',
    async run(page) {
      await goSettings(page, 'Claude hooks');
      await page.getByRole('list', { name: 'Hooks per environment' }).waitFor();
    },
  },
  {
    name: 'settings-hooks-diff',
    async run(page) {
      await goSettings(page, 'Claude hooks');
      const ubuntu = page.getByRole('list', { name: 'Hooks per environment' }).getByRole('listitem').filter({ hasText: 'WSL (Ubuntu)' });
      await ubuntu.getByRole('button', { name: 'Review changes' }).click();
      const dialog = page.getByRole('dialog', { name: 'Install hooks for WSL (Ubuntu)' });
      await dialog.getByRole('region', { name: /^Changes to / }).waitFor();
      await dialog.getByRole('checkbox').check();
      await settle(page, 300);
    },
  },
  {
    name: 'settings-notifications',
    async run(page) {
      await goSettings(page, 'Notifications');
      await page.getByRole('switch', { name: 'Quiet every day' }).click();
      await settle(page, 300);
    },
  },
  {
    name: 'settings-notifications-projects',
    async run(page) {
      await goSettings(page, 'Notifications');
      await scrollTo(page.getByRole('table', { name: 'Notifications per project' }));
      await page.getByRole('switch', { name: 'Also send to my phone, Atlas API' }).click();
      await settle(page, 300);
    },
  },
  {
    name: 'settings-phones',
    async run(page) {
      await goSettings(page, 'Phones and devices');
      await page.getByRole('list', { name: 'Paired devices' }).waitFor();
    },
  },
  {
    name: 'settings-pair-phone',
    async run(page) {
      await goSettings(page, 'Phones and devices');
      await page.getByRole('checkbox', { name: /^Prompt/ }).check();
      await page.getByRole('button', { name: 'Create pairing code' }).click();
      await page.getByRole('img', { name: 'QR code that holds the pairing code' }).waitFor();
      await scrollTo(page.getByRole('region', { name: 'Pair a phone' }));
    },
  },
  {
    name: 'settings-remote',
    async run(page) {
      await goSettings(page, 'Remote access');
      await page.getByLabel('Tailscale status').waitFor();
      await page.getByRole('switch', { name: /Allow my phone to reach Mini-Summa/ }).click();
      await page.getByText('Published to your tailnet').waitFor();
      await settle(page, 300);
    },
  },
  {
    name: 'settings-remote-problem',
    async run(page) {
      await withDemo(page, (handlers, server) => {
        handlers.featureState(server.data).tailscale = {
          ...handlers.defaultTailscale(), running: false, backendState: 'Stopped',
          problem: 'Tailscale is turned off. Open the Tailscale app and choose Connect (or run "tailscale up" in a terminal), then refresh.',
        };
      });
      await goSettings(page, 'Remote access');
      await page.getByText(/Tailscale is turned off/).waitFor();
      await settle(page, 300);
    },
  },
  {
    name: 'settings-push',
    async run(page) { await goSettings(page, 'Push notifications'); },
  },
  {
    name: 'settings-review',
    async run(page) { await goSettings(page, 'Review and handoff'); },
  },
  {
    name: 'settings-data',
    async run(page) {
      await goSettings(page, 'Data and privacy');
      await page.getByLabel('Storage details').waitFor();
      await settle(page, 300);
    },
  },
  {
    name: 'settings-data-cleanup',
    async run(page) {
      await goSettings(page, 'Data and privacy');
      await page.getByLabel('Activity feed, days').fill('3');
      await page.getByRole('button', { name: 'Save limits' }).click();
      await page.getByRole('button', { name: 'Preview the cleanup' }).click();
      await page.getByText(/Nothing has been removed yet\./).waitFor();
      await scrollTo(page.getByRole('region', { name: 'Clean up now' }));
    },
  },
  {
    name: 'settings-about',
    async run(page) {
      await goSettings(page, 'About and setup');
      await page.getByRole('list', { name: 'Setup steps' }).waitFor();
      await settle(page, 400);
    },
  },

  // ---- first run
  {
    name: 'onboarding-empty',
    open: { query: '?demo=1&scenario=empty', scene: false },
    async run(page) {
      await page.getByRole('region', { name: 'Set up Mini-Summa' }).waitFor();
      await page.getByRole('heading', { level: 3, name: /Claude Code is installed/ }).waitFor();
      await settle(page, 500);
    },
  },
  {
    name: 'onboarding-first-project',
    open: { query: '?demo=1&scenario=empty', scene: false },
    async run(page) {
      await page.getByRole('region', { name: 'Set up Mini-Summa' }).waitFor();
      await withDemo(page, (handlers, server) => server.call('projects.create', { body: { name: 'Mini-Summa', roots: [{ path: 'C:\\code\\mini-summa', env: 'win' }] } }));
      await page.locator('.ms-onb-layer[data-place="corner"]').waitFor();
      await settle(page, 500);
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
    const [width, height] = shot.size ?? SIZE;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.baseUrl = baseUrl;
    page.on('pageerror', (e) => problems.push(`${shot.name}: page error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`${shot.name}: console error: ${m.text()}`); });
    try {
      await open(page, shot.open);
      if (shot.run) await shot.run(page, { withDemo });
      const file = join(outDir, `features-${shot.name}-${width}x${height}.png`);
      await page.screenshot({ path: file });
      console.log(`wrote ${file}`);
    } catch (error) {
      problems.push(`${shot.name}: ${error.message.split('\n')[0]}`);
      await page.screenshot({ path: join(outDir, `features-${shot.name}-FAILED.png`) }).catch(() => {});
    }
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
