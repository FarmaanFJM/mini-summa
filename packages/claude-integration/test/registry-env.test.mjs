import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, createRegistry, detectEnv } from '../src/lib/registry.mjs';

const reg = createRegistry({ projects: [
  { id: 'gm', name: 'GitManager', roots: [{ env: 'win', path: 'C:\\Dev\\GitManager' }] },
  { id: 'herc', name: 'Herc', roots: [{ env: 'wsl:Ubuntu', path: '/home/u/herc' }] },
  { id: 'chess', name: 'Chess', roots: [{ env: 'wsl:Debian', path: '/home/u/herc' }, { env: 'win', path: 'D:\\Code\\Chess' }] },
] }, { platform: 'win32', real: false });

test('one Windows directory has the same identity from Windows, from WSL via /mnt/c, and with other spellings', () => {
  const a = canonicalize('C:\\Dev\\GitManager\\src', 'win');
  assert.deepEqual(a, canonicalize('c:/dev/gitmanager/src/', 'win'));
  assert.deepEqual(a, canonicalize('/mnt/c/Dev/GitManager/src', 'wsl:Ubuntu'));
  assert.deepEqual(a, canonicalize('/mnt/c/Dev/GitManager/src', 'wsl:Debian'));
  for (const env of ['win']) for (const cwd of ['C:\\Dev\\GitManager', 'c:\\dev\\gitmanager\\sub\\x']) assert.equal(reg.resolve(cwd, env).project.id, 'gm');
  assert.equal(reg.resolve('/mnt/c/Dev/GitManager/sub', 'wsl:Ubuntu').project.id, 'gm');
});

test('a WSL file system seen through \\\\wsl$ or \\\\wsl.localhost from Windows equals the path seen from inside WSL', () => {
  const inside = canonicalize('/home/u/herc/src', 'wsl:Ubuntu');
  assert.deepEqual(inside, canonicalize('\\\\wsl$\\Ubuntu\\home\\u\\herc\\src', 'win'));
  assert.deepEqual(inside, canonicalize('\\\\wsl.localhost\\Ubuntu\\home\\u\\herc\\src\\', 'win'));
  assert.equal(reg.resolve('\\\\wsl$\\Ubuntu\\home\\u\\herc', 'win').project.id, 'herc');
});

test('identical-looking POSIX paths in different distributions are different directories', () => {
  assert.equal(reg.resolve('/home/u/herc', 'wsl:Ubuntu').project.id, 'herc');
  assert.equal(reg.resolve('/home/u/herc', 'wsl:Debian').project.id, 'chess');
  assert.equal(reg.resolve('/home/u/herc', 'posix').project, null, 'a native Linux host is a third namespace');
  assert.notDeepEqual(canonicalize('/home/u/x', 'wsl:Ubuntu'), canonicalize('/home/u/x', 'wsl:Debian'));
});

test('WSL paths are case-sensitive, Windows paths are not', () => {
  assert.equal(reg.resolve('/home/u/Herc', 'wsl:Ubuntu').project, null);
  assert.equal(reg.resolve('c:\\DEV\\gitmanager', 'win').project.id, 'gm');
});

test('a sibling directory sharing a string prefix is not inside the project, in either namespace', () => {
  assert.equal(reg.resolve('C:\\Dev\\GitManager2', 'win').project, null);
  assert.equal(reg.resolve('/home/u/herc-old', 'wsl:Ubuntu').project, null);
});

test('drive roots and other drives work; unknown or missing input is explicit', () => {
  assert.equal(reg.resolve('D:\\Code\\Chess\\a', 'win').project.id, 'chess');
  assert.equal(reg.resolve('E:\\x', 'win').reason, 'unregistered_directory');
  assert.equal(reg.resolve(undefined, 'win').reason, 'no_cwd');
  assert.deepEqual(canonicalize('/mnt/d', 'wsl:Ubuntu'), { fs: 'win', path: 'd:\\' });
});

test('a custom WSL automount root is honoured; without it /mnt/c is the default', () => {
  assert.deepEqual(canonicalize('/win/c/Dev/x', 'wsl:Ubuntu', { automount: '/win/' }), canonicalize('C:\\Dev\\x', 'win'));
  assert.deepEqual(canonicalize('/mnt/c/Dev/x', 'wsl:Ubuntu', { automount: '/win/' }), { fs: 'wsl:Ubuntu', path: '/mnt/c/Dev/x' });
});

test('environment detection', () => {
  assert.equal(detectEnv('win32', {}), 'win');
  assert.equal(detectEnv('linux', { WSL_DISTRO_NAME: 'Ubuntu' }), 'wsl:Ubuntu');
  assert.equal(detectEnv('linux', {}), 'posix');
});

test('same project reached from native Windows and from WSL is one project but sessions stay per environment (see generations tests)', () => {
  assert.equal(reg.resolve('C:\\Dev\\GitManager', 'win').project.id, reg.resolve('/mnt/c/Dev/GitManager', 'wsl:Ubuntu').project.id);
});
