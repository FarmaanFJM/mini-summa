import type { EnvId } from '@minisumma/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { hostFolderCheck } from '../../src/infra/folders.ts';
import { createProjectsService } from '../../src/infra/projects.ts';
import { createSettingsService } from '../../src/infra/settings.ts';
import { failure, makeBase, tempDir, cleanupTempDirs } from './part1-fixtures.ts';
import type { TestBase } from './part1-fixtures.ts';
import fs from 'node:fs';
import path from 'node:path';

let base: TestBase;
afterEach(() => { base?.close(); cleanupTempDirs(); });

function make(opts: { folderCheck?: ReturnType<typeof hostFolderCheck>; hostEnv?: EnvId; hostPlatform?: 'win32' | 'linux' | 'darwin' } = {}) {
  base = makeBase();
  const settings = createSettingsService({ base });
  return createProjectsService({ base, settings, hostPlatform: opts.hostPlatform ?? 'linux', hostEnv: opts.hostEnv ?? 'posix', folderCheck: opts.folderCheck });
}

// the environment the test process itself runs on: temp folders are Windows paths on a Windows runner
const HOST: EnvId = process.platform === 'win32' ? 'win' : 'posix';
const HOST_PLATFORM = process.platform === 'win32' ? 'win32' : 'linux';

const SCOPE = 'g-p-0123456789abcdef0123456789abcdef-caissa-trainer';

describe('a project that has only a GitHub repository', () => {
  it('is valid, has no folders, and is stored and read back as it was made', () => {
    const projects = make();
    const p = projects.create({ name: 'CaissaTrainer', githubRepo: 'FarmaanFIM/CaissaTrainer' });
    expect(p).toMatchObject({ name: 'CaissaTrainer', githubRepo: 'FarmaanFIM/CaissaTrainer', roots: [], chatgptProject: null });
    expect(projects.get(p.id)).toEqual(p);
  });

  it('can get a folder later without touching anything else', () => {
    const projects = make();
    const p = projects.create({ name: 'CaissaTrainer', githubRepo: 'acme/caissa', chatgptProject: { url: `https://chatgpt.com/g/${SCOPE}/project` } });
    const dir = tempDir();
    const after = projects.addRoot(p.id, { path: dir });
    expect(after.roots.map((r) => r.path)).toEqual([dir]);
    expect(after).toMatchObject({ githubRepo: 'acme/caissa', chatgptProject: { scopeId: SCOPE } });
  });
});

describe('a linked ChatGPT Project', () => {
  it('is stored with its page address and a title taken from the address', () => {
    const projects = make();
    const p = projects.create({ name: 'Caissa', chatgptProject: { url: `https://chatgpt.com/g/${SCOPE}/c/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d` } });
    expect(p.chatgptProject).toEqual({ url: `https://chatgpt.com/g/${SCOPE}/project`, scopeId: SCOPE, title: 'Caissa trainer' });
    expect(projects.get(p.id)?.chatgptProject).toEqual(p.chatgptProject);
  });

  it('keeps the title the person typed', () => {
    const projects = make();
    const p = projects.create({ name: 'Caissa', chatgptProject: { url: `https://chatgpt.com/g/${SCOPE}/project`, title: '  Chess app  ' } });
    expect(p.chatgptProject?.title).toBe('Chess app');
  });

  it('can be linked, changed and unlinked on an existing project, and only the link changes', () => {
    const projects = make();
    const p = projects.create({ name: 'Caissa', githubRepo: 'acme/caissa' });
    const linked = projects.update(p.id, { chatgptProject: { url: `https://chatgpt.com/g/${SCOPE}/project` } });
    expect(linked.chatgptProject?.scopeId).toBe(SCOPE);
    expect(linked.githubRepo).toBe('acme/caissa');
    const retitled = projects.update(p.id, { chatgptProject: { url: `https://chatgpt.com/g/${SCOPE}/project`, title: 'Chess' } });
    expect(retitled.chatgptProject?.title).toBe('Chess');
    const unlinked = projects.update(p.id, { chatgptProject: null });
    expect(unlinked.chatgptProject).toBeNull();
    expect(unlinked.githubRepo).toBe('acme/caissa');
  });

  it('does nothing, and does not emit, when the same link is saved again', () => {
    const projects = make();
    const p = projects.create({ name: 'Caissa', chatgptProject: { url: `https://chatgpt.com/g/${SCOPE}/project` } });
    const before = base.eventsOf('project.upserted').length;
    projects.update(p.id, { chatgptProject: { url: `https://chatgpt.com/g/${SCOPE}/project` } });
    expect(base.eventsOf('project.upserted').length).toBe(before);
  });

  it('is refused with an explanation when the address is not a project', () => {
    const projects = make();
    const e = failure(() => projects.create({ name: 'x', chatgptProject: { url: 'https://chatgpt.com/c/6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' } }));
    expect(e).toMatchObject({ status: 400, code: 'invalid_chatgpt_project' });
    expect(e.message).toMatch(/single conversation outside any project/);
    expect(failure(() => projects.create({ name: 'x', chatgptProject: { url: 'https://example.com/g/g-p-1/project' } }))).toMatchObject({ code: 'invalid_chatgpt_project' });
    expect(projects.list()).toEqual([]); // nothing half-made
  });
});

describe('checking that a folder exists before it joins a project', () => {
  it('accepts a folder that is there', () => {
    const projects = make({ folderCheck: hostFolderCheck(HOST), hostEnv: HOST, hostPlatform: HOST_PLATFORM });
    const dir = tempDir();
    expect(projects.create({ name: 'a', roots: [{ path: dir }] }).roots.map((r) => r.path)).toEqual([dir]);
  });

  it('says that a folder does not exist, with what to do about it, and creates nothing', () => {
    const projects = make({ folderCheck: hostFolderCheck('posix') });
    const e = failure(() => projects.create({ name: 'a', roots: [{ path: '/definitely/not/here' }] }));
    expect(e).toMatchObject({ status: 400, code: 'root_not_found' });
    expect(e.message).toBe('This folder does not exist: /definitely/not/here. Check the spelling, or choose it with Browse.');
    expect(projects.list()).toEqual([]);
  });

  it('says that a file is not a folder', () => {
    const projects = make({ folderCheck: hostFolderCheck(HOST), hostEnv: HOST, hostPlatform: HOST_PLATFORM });
    const file = path.join(tempDir(), 'a.txt');
    fs.writeFileSync(file, 'x');
    const p = projects.create({ name: 'a' });
    expect(failure(() => projects.addRoot(p.id, { path: file }))).toMatchObject({ code: 'root_not_directory' });
  });

  it('does not refuse for a reason it does not understand, and does not look at other environments', () => {
    const odd = hostFolderCheck('posix', () => { throw Object.assign(new Error('slow drive'), { code: 'EIO' }); });
    expect(odd('posix', '/mnt/slow')).toBeNull();
    expect(hostFolderCheck('win')('wsl:Ubuntu', '/home/me/app')).toBeNull(); // a WSL folder is checked when a session starts
    const denied = hostFolderCheck('posix', () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); });
    expect(denied('posix', '/root/x')).toMatchObject({ code: 'root_not_readable' });
  });

  it('is off unless asked for, so a core made without it accepts any readable path', () => {
    const projects = make();
    expect(projects.create({ name: 'a', roots: [{ path: '/not/checked' }] }).roots).toHaveLength(1);
  });
});
