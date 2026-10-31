#!/usr/bin/env node
// Screenshots of the handoff strip (the band above the two panes while a report waits for the person), taken the same way as
// scripts/screenshots-features.mjs: Vite serves the renderer, Chromium opens it with the in-memory demo core (?demo=1), and the
// cases the base scene does not have (a very long title, a long message in parts, several reports waiting) are added to the
// running core so the page updates live. The base demo scene already has the others: GitManager has one report ready and one
// copied (the strip shows the copied one, and "+1 more"); Atlas API has one whose conversation is not verified yet.
//
//   node apps/desktop/scripts/screenshots-handoff.mjs [--only name,name] [--out <dir>]
//
// Output: docs/screenshots/handoff-strip-<name>-<width>x<height>.png
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

async function open(page) {
  await page.goto(`${page.baseUrl}/?demo=1`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector('.ms-shell', { timeout: 15_000 });
  await page.waitForFunction(() => Boolean(window.__minisummaDemo), null, { timeout: 15_000 });
  await page.evaluate(async () => {
    // The desktop app copies through the core (native clipboard); a headless browser has no clipboard to write to.
    const handlers = await import('/src/dev/demo/features-handlers.ts');
    handlers.featureState(window.__minisummaDemo.server.data).clipboard = 'native';
  });
  await settle(page, 400);
}

/** Runs code in the page against the demo core: `add(...)` builds one more report with a delivery in a given state. */
const addReport = (page, spec) => page.evaluate(async (s) => {
  const seed = await import('/src/dev/demo/features-seed.ts');
  const body = s.longBody ? seed.longBody(s.longBody) : undefined;
  seed.addReportScene(window.__minisummaDemo.server, { projectId: s.projectId, title: s.title, state: s.state, body, minutesAgo: s.minutesAgo, id: s.id });
}, spec);

const projectButton = (page, name) => page.getByRole('button', { name: new RegExp(`^${name}(,|$)`) });
const strip = (page) => page.getByRole('region', { name: /^Report handoff/ });

async function showProject(page, name) {
  await projectButton(page, name).click();
  await page.getByRole('heading', { level: 1, name }).waitFor();
}

const ATLAS = 'prj_atlas';
const LONG_TITLE = 'Replace the legacy session store with the new append-only event log, migrate every existing user, keep the old endpoints answering for one release, and document the rollback steps for the on-call engineers';

// ------------------------------------------------------------------------------------------------ the shots

const both = (name, run) => [[LANDSCAPE, 'landscape'], [PORTRAIT, 'portrait']].map(([size, kind]) => ({ name: `${name}-${kind}`, size, run }));

const shots = [
  // A report is ready. The conversation it goes to is named, and the main button is where the eye lands.
  ...both('ready', async (page) => {
    await showProject(page, 'Atlas API');
    await strip(page).waitFor();
    await settle(page);
  }),
  // After "Copy and open": the message is on the clipboard, the conversation is open in the pane, and the strip waits for the person.
  ...both('copied', async (page) => {
    await showProject(page, 'Atlas API');
    await strip(page).getByRole('button', { name: 'Copy and open' }).click();
    await strip(page).getByRole('button', { name: 'I sent it' }).waitFor();
    await settle(page, 450);
  }),
  // Several reports wait: the one the person is in the middle of is shown, the others are one link away.
  ...both('several', async (page) => {
    await showProject(page, 'GitManager');
    await strip(page).getByRole('button', { name: /more/ }).waitFor();
    await settle(page);
  }),
  // A very long title is cut to two lines; the whole sentence is the tooltip and the name of the region.
  ...both('long-title', async (page) => {
    await addReport(page, { projectId: ATLAS, title: LONG_TITLE, state: 'ready_for_handoff', id: 'rpt_long_title' });
    await showProject(page, 'Atlas API');
    await strip(page).getByText(/^Report ready: Replace the legacy/).waitFor();
    await settle(page);
  }),
  ...both('long-title-copied', async (page) => {
    await addReport(page, { projectId: ATLAS, title: LONG_TITLE, state: 'ready_for_handoff', id: 'rpt_long_title' });
    await showProject(page, 'Atlas API');
    await strip(page).getByRole('button', { name: 'Copy and open' }).click();
    await strip(page).getByRole('button', { name: 'I sent it' }).waitFor();
    await settle(page, 450);
  }),
  // The sidebar is only a rail: the strip gets the width and the pane below it moves with it.
  {
    name: 'sidebar-collapsed-landscape', size: LANDSCAPE,
    async run(page) {
      await showProject(page, 'Atlas API');
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await page.getByRole('button', { name: 'Expand sidebar' }).waitFor();
      await settle(page, 300);
      await strip(page).getByRole('button', { name: 'Copy and open' }).click();
      await strip(page).getByRole('button', { name: 'I sent it' }).waitFor();
      await settle(page, 450);
    },
  },
  // A long message is copied in parts: the first press copies part 1, the main button then names the next one, and "I sent it" appears
  // when every part is copied.
  {
    name: 'multipart-landscape', size: LANDSCAPE,
    async run(page) {
      await addReport(page, { projectId: ATLAS, title: 'Move the clone pipeline to libgit2 1.9', state: 'ready_for_handoff', longBody: 30000, id: 'rpt_multi' });
      await showProject(page, 'Atlas API');
      await strip(page).getByRole('button', { name: 'Copy and open' }).click();
      await strip(page).getByRole('button', { name: 'Copy part 2 of 3 and open' }).waitFor();
      await settle(page, 450);
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
    try {
      await open(page);
      await shot.run(page);
      const file = join(outDir, `handoff-strip-${shot.name}-${width}x${height}.png`);
      await page.screenshot({ path: file });
      console.log(`wrote ${file}`);
    } catch (error) {
      problems.push(`${shot.name}: ${error.message.split('\n')[0]}`);
      await page.screenshot({ path: join(outDir, `handoff-strip-${shot.name}-FAILED.png`) }).catch(() => {});
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
