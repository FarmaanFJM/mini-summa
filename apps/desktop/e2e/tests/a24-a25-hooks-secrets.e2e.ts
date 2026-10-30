// A24: Claude Code hooks are installed only after the person has seen the exact change and agreed to it.
// A25: everything secret the app creates lives in its data directory; nothing is written into a repository.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import type { Page } from 'playwright';
import { launchApp } from '../helpers/app.ts';
import { createProject, startSession } from '../helpers/core.ts';
import { REPO_ROOT } from '../helpers/env.ts';
import { evidence } from '../helpers/evidence.ts';
import { finishTask } from '../helpers/flow.ts';
import { scenario } from '../helpers/scenario.ts';
import { snapshotTree } from '../helpers/sandbox.ts';
import { conversationUrl, uuidOf } from '../helpers/standin.ts';
import { openSettings } from '../helpers/ui.ts';

const sha256 = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');

async function openHooksSettings(page: Page): Promise<void> {
  await openSettings(page);
  await page.getByRole('complementary').getByRole('button', { name: 'Claude hooks' }).click();
  await page.getByRole('heading', { level: 1, name: 'Claude hooks' }).waitFor();
}

/** What the dialog shows as the change: the lines of the diff, one per line, exactly as rendered. */
async function shownDiff(page: Page): Promise<string[]> {
  const region = page.getByRole('region', { name: /^Changes to / });
  await region.waitFor();
  const lines = await region.evaluate((el) => Array.from(el.children).map((c) => c.textContent ?? ''));
  return lines.map((l) => l.replace(/\s+$/, ''));
}

scenario('[A24] Hook installation is permission-gated (exact diff, explicit consent, other hooks untouched)', async () => {
  const h = await launchApp();
  const settingsFile = path.join(h.sandbox.home, '.claude', 'settings.json');
  const backups = path.join(h.sandbox.data, 'backups');

  // A person's real settings file: other settings, a permission rule, and hooks of their own on events Mini-Summa also uses.
  const seed = {
    theme: 'dark',
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo my-own-stop-hook' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo my-own-pretool-hook' }] }],
    },
  };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify(seed, null, 2)}\n`);
  const original = fs.readFileSync(settingsFile);
  const untouched = (): boolean => fs.readFileSync(settingsFile).equals(original);
  const backupFiles = (): string[] => (fs.existsSync(backups) ? fs.readdirSync(backups) : []);
  expect(backupFiles()).toEqual([]);

  await openHooksSettings(h.page);
  const card = h.page.getByRole('list', { name: 'Hooks per environment' });
  await card.getByText('Not installed').waitFor();
  await card.getByText(settingsFile, { exact: true }).waitFor(); // it names the file that would change, in the sandbox's home

  // 1. Asking what would change writes nothing. The dialog shows the file, the backup, and the exact lines.
  await card.getByRole('button', { name: 'Review changes' }).click();
  const dialog = h.page.getByRole('dialog', { name: /^Install hooks for / });
  await dialog.waitFor();
  await dialog.getByText(settingsFile, { exact: true }).first().waitFor();
  const diff = await shownDiff(h.page);
  const plan = await h.api.call('hooks.plan', { body: { env: 'posix', action: 'install' } });
  const wantedLines = plan.unifiedDiff.split('\n').map((l) => l.replace(/\s+$/, ''));
  expect(diff).toEqual(wantedLines); // the screen shows the core's plan, line for line
  const added = diff.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  expect(added.length).toBeGreaterThan(5);
  expect(added.join('\n')).toContain('--handler ms-user');
  expect(diff.some((l) => l.startsWith('-') && !l.startsWith('---'))).toBe(false); // adds only: nothing of the person's is removed
  expect(untouched()).toBe(true);
  expect(backupFiles()).toEqual([]);

  // 2. Without consent the button does nothing: it is disabled, and a click would write nothing.
  const install = dialog.getByRole('button', { name: 'Install hooks', exact: true });
  expect(await install.isDisabled()).toBe(true);
  await install.click({ force: true, trial: true }).catch(() => undefined);
  expect(untouched()).toBe(true);
  expect((await h.api.call('hooks.list')).find((x) => x.env === 'posix')?.installed).toBe(false);

  // 3. Cancel leaves everything as it was.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });
  expect(untouched()).toBe(true);
  expect(backupFiles()).toEqual([]);

  // 4. A file that changes after the diff was shown is not overwritten on the old agreement: nothing is written, consent is withdrawn.
  await card.getByRole('button', { name: 'Review changes' }).click();
  await dialog.waitFor();
  const consent = dialog.getByRole('checkbox', { name: new RegExp(`I have read these changes to ${settingsFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
  await consent.check();
  expect(await install.isEnabled()).toBe(true);
  const edited = { ...seed, model: 'sonnet' };
  fs.writeFileSync(settingsFile, `${JSON.stringify(edited, null, 2)}\n`);
  const editedBytes = fs.readFileSync(settingsFile);
  await install.click();
  await dialog.getByText(/settings\.json changed since you looked, so nothing was written/).waitFor();
  expect(fs.readFileSync(settingsFile).equals(editedBytes)).toBe(true); // still exactly what the person wrote
  expect(backupFiles()).toEqual([]);
  expect(await consent.isChecked()).toBe(false);
  expect(await install.isDisabled()).toBe(true);

  // 5. Read again, agree again, install: our entries are added, everything else is as it was; a backup of the old file is kept.
  const diffAgain = await shownDiff(h.page);
  expect(diffAgain.join('\n')).not.toContain('"model"'); // the person's own edit is context, not part of the change
  await consent.check();
  await install.click();
  await dialog.waitFor({ state: 'detached' });
  const installed = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as typeof seed & { model: string; hooks: Record<string, unknown[]> };
  expect(installed.theme).toBe('dark');
  expect(installed.model).toBe('sonnet');
  expect(installed.permissions).toEqual(seed.permissions);
  expect(installed.hooks.Stop).toEqual(expect.arrayContaining(seed.hooks.Stop));
  expect(installed.hooks.PreToolUse).toEqual(expect.arrayContaining(seed.hooks.PreToolUse));
  const ours = (group: unknown): boolean => JSON.stringify(group).includes('--handler ms-user');
  expect(Object.values(installed.hooks).some((groups) => groups.some(ours))).toBe(true);
  expect(Object.keys(installed.hooks).filter((event) => installed.hooks[event].some(ours)).length).toBeGreaterThanOrEqual(6);
  const backupsNow = backupFiles();
  expect(backupsNow).toHaveLength(1);
  expect(fs.readFileSync(path.join(backups, backupsNow[0])).equals(editedBytes)).toBe(true); // the backup is the file as it was before the write
  await card.getByText('Installed', { exact: false }).first().waitFor();
  expect((await h.api.call('hooks.list')).find((x) => x.env === 'posix')?.installed).toBe(true);

  // 6. Removal is gated the same way, and leaves the person's own hooks and settings exactly as they were.
  await card.getByRole('button', { name: 'Review removal' }).click();
  const removal = h.page.getByRole('dialog', { name: /^Remove hooks for / });
  await removal.waitFor();
  const removeDiff = await shownDiff(h.page);
  expect(removeDiff.some((l) => l.startsWith('-') && !l.startsWith('---') && l.includes('ms-user'))).toBe(true);
  const remove = removal.getByRole('button', { name: 'Remove hooks', exact: true });
  expect(await remove.isDisabled()).toBe(true);
  const beforeRemoval = fs.readFileSync(settingsFile);
  await removal.getByRole('checkbox', { name: /I have read these changes to/ }).check();
  expect(fs.readFileSync(settingsFile).equals(beforeRemoval)).toBe(true); // reading and agreeing change nothing
  await remove.click();
  await removal.waitFor({ state: 'detached' });
  const afterRemoval = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  expect(afterRemoval).toEqual(edited); // the person's file, as they last wrote it
  expect(fs.readFileSync(settingsFile).equals(editedBytes)).toBe(true);
  expect((await h.api.call('hooks.list')).find((x) => x.env === 'posix')?.installed).toBe(false);
  evidence('A24', `the dialog named ${settingsFile} and listed ${added.length} added lines, identical to the core's plan, with no line removed; before agreement the button was disabled and the file, byte for byte, and the backups folder were untouched (also after Cancel); a file edited while the dialog was open produced "nothing was written" and withdrew the agreement; after reading and agreeing again, hooks were added next to the person's own Stop and PreToolUse hooks, theme, permissions and model, with a backup equal to the old file; removal asked the same way and restored the file byte for byte`);
});

scenario('[A25] Runtime secrets remain outside the repository', async () => {
  // Launched the way a developer launches it, from inside the repository: any relative write would land in the work tree.
  const h = await launchApp({ cwd: REPO_ROOT });
  const marker = `A25-${crypto.randomBytes(6).toString('hex')}`;
  const made = await createProject(h, 'Secrets', { conversations: [conversationUrl(uuidOf('a'))], git: true });
  const repoBefore = snapshotTree(made.dir);
  const session = await startSession(h, made.project.id);
  const report = await finishTask(h, { project: made.project, session }, `Task ${marker}`);

  // Secrets of every kind the app makes: the desktop token (in memory, in the page), a device token and its pairing code.
  const offer = await h.api.call('pairing.createOffer', { body: { scopes: ['read', 'notify'] } });
  const paired = await h.api.call('pairing.redeem', { body: { offerId: offer.id, code: offer.code, deviceName: 'Test phone', platform: 'android' } });
  const deviceToken = paired.token;
  expect(deviceToken).toMatch(/^msv_/);
  expect(h.token).toMatch(/^msd_/);

  // Where things are: in the data directory, private to the owner.
  const mode = (p: string): number => fs.statSync(p).mode & 0o777;
  expect(fs.existsSync(path.join(h.sandbox.data, 'mini-summa.db'))).toBe(true);
  expect(mode(h.sandbox.data)).toBe(0o700);
  expect(mode(path.join(h.sandbox.data, 'mini-summa.db'))).toBe(0o600);
  for (const sub of ['spool', 'logs', 'managed-settings']) {
    const dir = path.join(h.sandbox.data, sub);
    expect(fs.existsSync(dir), `${sub} is under the data directory`).toBe(true);
    expect(mode(dir)).toBe(0o700);
  }

  // The secrets are not written in the clear anywhere on disk, in any of the app's own places.
  const everyFile = (root: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full); else if (entry.isFile()) out.push(full);
      }
    };
    walk(root);
    return out;
  };
  const containing = (files: string[], needle: string): string[] => files.filter((f) => { try { return fs.readFileSync(f).includes(needle); } catch { return false; } });
  const sandboxFiles = everyFile(h.sandbox.root).filter((f) => !f.includes(`${path.sep}fake-claude-state${path.sep}`));
  expect(containing(sandboxFiles, h.token), 'the desktop token is in memory only').toEqual([]);
  expect(containing(sandboxFiles, deviceToken), 'a device token is stored only as a hash').toEqual([]);
  expect(containing(sandboxFiles, offer.code), 'a pairing code is stored only as a hash').toEqual([]);
  const withMarker = containing(sandboxFiles, marker).map((f) => path.relative(h.sandbox.root, f));
  expect(withMarker.some((f) => f.startsWith(`data${path.sep}`)), `the report text (${marker}) is stored in the data directory`).toBe(true);
  expect(withMarker.filter((f) => !f.startsWith(`data${path.sep}`) && !f.startsWith(`fake`)), 'the report text appears only under the data directory').toEqual([]);

  // Nothing was written into the project's repository by Mini-Summa.
  expect(snapshotTree(made.dir)).toEqual(repoBefore);
  expect(fs.existsSync(path.join(made.dir, '.claude'))).toBe(false);
  expect(fs.existsSync(path.join(made.dir, 'CLAUDE.md'))).toBe(false);

  // And nothing in this repository's work tree (every tracked file and every untracked file git would show) holds a secret or the report.
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean);
  const workTree = tracked.map((f) => path.join(REPO_ROOT, f)).filter((f) => { try { return fs.statSync(f).isFile() && fs.statSync(f).size < 8 * 1024 * 1024; } catch { return false; } });
  expect(workTree.length).toBeGreaterThan(100);
  for (const [what, needle] of [['the desktop token', h.token], ['a device token', deviceToken], ['a pairing code', offer.code], ['the report text', marker]] as const) {
    expect(containing(workTree, needle).map((f) => path.relative(REPO_ROOT, f)), `${what} must not be in the repository's work tree`).toEqual([]);
  }
  // No runtime artefact of the app appeared in it either (a database, a spool, a data folder, a Mini-Summa profile).
  const runtimeNames = /(^|\/)(mini-summa\.db(-wal|-shm)?|registry\.json|spool|managed-settings|\.minisumma|electron-profile)(\/|$)/;
  expect(tracked.filter((f) => runtimeNames.test(f)).filter((f) => !f.startsWith('apps/desktop/e2e/') && !/(^|\/)test(s)?\//.test(f))).toEqual([]);
  expect(report.id).toBeTruthy();
  evidence('A25', `data directory ${path.basename(h.sandbox.data)} (0700) holds the database (0600), spool, logs and managed settings, and the report text; neither the desktop token nor a device token (${deviceToken.slice(0, 4)}...) is on disk in the clear anywhere in the sandbox (${sandboxFiles.length} files scanned); the project's repository was unchanged (${Object.keys(repoBefore).length} entries, no .claude or CLAUDE.md); ${workTree.length} files of this repository's work tree were scanned for the tokens and the report text: none; the app was launched with the repository as its working directory`);
});
