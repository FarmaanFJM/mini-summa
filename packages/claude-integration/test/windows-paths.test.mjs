import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, createRegistry } from '../src/lib/registry.mjs';

// Which project a session's working directory belongs to, for the spellings Windows and WSL2 really produce.
// Deliberate difference from the proof of concept, see docs/CHANGES-FROM-POC.md:
//   change 15  \\?\ and \\.\ paths are read as the path they name, and the name of a WSL distribution is compared without case
// The tests without a CHANGE prefix pin behaviour that was already right and did not change.
// EVERYTHING HERE IS SIMULATED: pure string logic (path.win32 on any machine, no file system access: { real: false }). Nothing ran on Windows or WSL2.
// Session identity is a different matter and is not decided here: a session is (environment, session id), never merged (docs/ARCHITECTURE.md).

const registry = (roots, defaultEnv = 'win') => createRegistry({ defaultEnv, projects: [{ id: 'p1', name: 'App', roots }] }, { real: false, platform: 'win32' });
const projectOf = (reg, cwd, env) => reg.resolve(cwd, env).project?.id ?? null;

test('SIMULATED Windows: a drive path matches whatever the case of the drive letter and folders, forward or back slashes, trailing separators', () => {
  const reg = registry([{ path: 'C:\\Dev\\App', env: 'win' }]);
  for (const cwd of ['C:\\Dev\\App', 'c:\\dev\\app', 'C:/Dev/App', 'C:/Dev/App/', 'c:\\DEV\\APP\\src\\deep', 'C:\\Dev\\App\\..\\App\\src', 'C:\\Dev\\\\App']) {
    assert.equal(projectOf(reg, cwd, 'win'), 'p1', cwd);
  }
  for (const cwd of ['C:\\Dev\\Application', 'C:\\Dev', 'D:\\Dev\\App', 'C:\\Dev\\App2\\x']) assert.equal(projectOf(reg, cwd, 'win'), null, cwd);
});

test('CHANGE 15 (simulated Windows): the long-path prefix (\\\\?\\C:\\..., //?/c:/...) names the same folder', () => {
  const reg = registry([{ path: 'C:\\Dev\\App', env: 'win' }]);
  for (const cwd of ['\\\\?\\C:\\Dev\\App', '\\\\?\\c:\\dev\\app\\src', '//?/C:/Dev/App/src', '\\\\.\\C:\\Dev\\App']) assert.equal(projectOf(reg, cwd, 'win'), 'p1', cwd);
  assert.deepEqual(canonicalize('\\\\?\\C:\\Dev\\App\\', 'win'), canonicalize('c:/dev/app', 'win'));
  // and in the root, when that is what was registered
  const prefixed = registry([{ path: '\\\\?\\C:\\Dev\\App', env: 'win' }]);
  assert.equal(projectOf(prefixed, 'C:\\Dev\\App\\src', 'win'), 'p1');
});

test('SIMULATED Windows: other uses of the prefix are not turned into a drive path', () => {
  assert.notDeepEqual(canonicalize('\\\\?\\Volume{11111111-1111-4111-8111-111111111111}\\x', 'win'), canonicalize('C:\\x', 'win'));
  assert.equal(canonicalize('\\\\?\\GLOBALROOT\\Device\\x', 'win').fs, 'win');
});

test('SIMULATED Windows: a network share is its own namespace of folders, compared without case', () => {
  const reg = registry([{ path: '\\\\Server\\Share\\Code', env: 'win' }]);
  assert.equal(projectOf(reg, '\\\\server\\share\\code\\app', 'win'), 'p1');
  assert.equal(projectOf(reg, '//SERVER/SHARE/CODE', 'win'), 'p1');
  assert.equal(projectOf(reg, '\\\\\\\\server\\share\\codex', 'win'), null);
  assert.equal(projectOf(reg, 'C:\\server\\share\\code', 'win'), null);
});

test('CHANGE 15 (simulated WSL): a root registered as \\\\wsl$\\Distro\\... or \\\\wsl.localhost\\Distro\\... is the Linux folder a WSL session reports', () => {
  for (const root of ['\\\\wsl$\\Ubuntu\\home\\u\\proj', '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj\\', '//wsl.localhost/Ubuntu/home/u/proj', '\\\\?\\UNC\\wsl$\\Ubuntu\\home\\u\\proj']) {
    const reg = registry([{ path: root, env: 'win' }]);
    assert.equal(projectOf(reg, '/home/u/proj', 'wsl:Ubuntu'), 'p1', root);
    assert.equal(projectOf(reg, '/home/u/proj/src/lib', 'wsl:Ubuntu'), 'p1', root);
    assert.equal(projectOf(reg, '/home/u/proj-other', 'wsl:Ubuntu'), null, root);
  }
});

test('CHANGE 15 (simulated WSL): the distribution name is not case-sensitive (Windows treats \\\\wsl$\\ubuntu and \\\\wsl$\\Ubuntu as the same share), nothing else is', () => {
  const typedLower = registry([{ path: '\\\\wsl$\\ubuntu\\home\\u\\proj', env: 'win' }]);
  assert.equal(projectOf(typedLower, '/home/u/proj', 'wsl:Ubuntu'), 'p1');
  const asRoot = registry([{ path: '/home/u/proj', env: 'wsl:ubuntu' }]);
  assert.equal(projectOf(asRoot, '/home/u/proj/x', 'wsl:Ubuntu'), 'p1');
  assert.equal(projectOf(asRoot, '/HOME/u/proj', 'wsl:Ubuntu'), null, 'Linux paths stay case-sensitive');
  assert.equal(projectOf(asRoot, '/home/u/proj', 'wsl:Debian'), null, 'another distribution is another file system');
  assert.equal(projectOf(asRoot, '/home/u/proj', 'posix'), null, 'and so is native Linux');
  assert.equal(projectOf(asRoot, 'C:\\home\\u\\proj', 'win'), null);
});

test('SIMULATED WSL: distribution names with dots and dashes, and folders with spaces and non-ASCII letters', () => {
  const reg = registry([
    { path: '\\\\wsl.localhost\\Ubuntu-22.04\\home\\zoë\\my project', env: 'win' },
    { path: 'C:\\Users\\Zoë Müller\\Mein Projekt', env: 'win' },
  ]);
  assert.equal(projectOf(reg, '/home/zoë/my project/src', 'wsl:Ubuntu-22.04'), 'p1');
  assert.equal(projectOf(reg, '/home/zoë/my project', 'wsl:Ubuntu-24.04'), null);
  assert.equal(projectOf(reg, 'c:/users/zoë müller/mein projekt/x', 'win'), 'p1');
  assert.equal(projectOf(reg, '/mnt/c/Users/Zoë Müller/Mein Projekt/x', 'wsl:Debian'), 'p1', 'the Windows folder seen through /mnt/c from any distribution');
});

test('SIMULATED WSL: /mnt/<drive>/... in a distribution is the Windows folder, so one project covers both views of it', () => {
  const reg = registry([{ path: 'C:\\Dev\\App', env: 'win' }]);
  assert.equal(projectOf(reg, '/mnt/c/Dev/App/src', 'wsl:Ubuntu'), 'p1');
  assert.equal(projectOf(reg, '/mnt/C/Dev/App', 'wsl:Ubuntu'), 'p1', 'the drive letter is case-insensitive in the mapping');
  assert.equal(projectOf(reg, '/mnt/d/Dev/App', 'wsl:Ubuntu'), null);
  assert.equal(projectOf(reg, '/mnt/c/Dev/App', 'posix'), null, 'a Linux host has no /mnt/c mapping');
  const inWsl = registry([{ path: '/mnt/c/Dev/App', env: 'wsl:Ubuntu' }]);
  assert.equal(projectOf(inWsl, 'C:\\Dev\\App\\x', 'win'), 'p1', 'and the other way round');
});

test('SIMULATED: a Windows session and a WSL session in the same folder resolve to the same project but are different file systems', () => {
  const reg = registry([{ path: 'C:\\Dev\\App', env: 'win' }]);
  assert.equal(reg.resolve('C:\\Dev\\App', 'win').canonical.fs, 'win');
  assert.equal(reg.resolve('/mnt/c/Dev/App', 'wsl:Ubuntu').canonical.fs, 'win', 'the folder is the same ...');
  assert.equal(canonicalize('/home/u/x', 'wsl:Ubuntu').fs, 'wsl:Ubuntu', '... but a Linux folder belongs to its distribution');
  assert.notEqual(canonicalize('/home/u/x', 'wsl:Ubuntu').fs, canonicalize('/home/u/x', 'wsl:Debian').fs);
});

test('CHANGE 15 (simulated): two projects claiming one folder through different spellings are reported as ambiguous, never guessed', () => {
  const reg = createRegistry({
    defaultEnv: 'win',
    projects: [
      { id: 'a', name: 'A', roots: [{ path: '\\\\wsl$\\Ubuntu\\home\\u\\proj', env: 'win' }] },
      { id: 'b', name: 'B', roots: [{ path: '/home/u/proj', env: 'wsl:ubuntu' }] },
    ],
  }, { real: false, platform: 'win32' });
  const r = reg.resolve('/home/u/proj/x', 'wsl:Ubuntu');
  assert.equal(r.project, null);
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual([...r.candidates].sort(), ['a', 'b']);
});
