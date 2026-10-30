// The readings behind the project dialogs, as pure functions: what a pasted address, a repository, a folder and a name mean, and the
// one body that creating a project sends for each way of starting. There is no draft any more, so there is no draft to test: a
// reading either approves a value or says why not.
import { describe, expect, it } from 'vitest';
import {
  automaticTitleOf, checkName, failureField, folderName, planCreate, readChatGptAddress, readFolder, readGithub, repoName, suggestName,
} from '../../src/renderer/src/features/projects/readings';
import type { NewProjectInput } from '../../src/renderer/src/features/projects/readings';

const PROJECT = 'https://chatgpt.com/g/g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer/project';
const CHAT_IN_PROJECT = 'https://chatgpt.com/g/g-p-6720aa11bb22cc33dd44ee55ff66aa77-caissa-trainer/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';

const input = (over: Partial<NewProjectInput>): NewProjectInput => ({
  source: 'empty', address: '', repo: '', folder: '', hostPlatform: 'win32', distro: null, name: 'Billing', ...over,
});

describe('name', () => {
  it('is required, trimmed, and at most 120 characters', () => {
    expect(checkName('  Atlas  ')).toEqual({ ok: true, value: 'Atlas' });
    expect(checkName('')).toEqual({ ok: false, message: 'Give the project a name.' });
    expect(checkName('   ')).toEqual({ ok: false, message: 'Give the project a name.' });
    expect(checkName('x'.repeat(120)).ok).toBe(true);
    expect(checkName('x'.repeat(121))).toEqual({ ok: false, message: 'Use 120 characters or fewer.' });
  });
});

describe('the address of a ChatGPT Project', () => {
  it('says nothing about an empty field', () => {
    expect(readChatGptAddress('')).toEqual({ kind: 'empty' });
    expect(readChatGptAddress('   ')).toEqual({ kind: 'empty' });
  });

  it('reads the project page and the words in it as the title', () => {
    expect(readChatGptAddress(PROJECT)).toEqual({ kind: 'project', url: PROJECT, title: 'Caissa trainer', named: true, fromConversation: false });
  });

  it('turns a conversation inside the project into the project page, and says that it did', () => {
    expect(readChatGptAddress(CHAT_IN_PROJECT)).toEqual({ kind: 'project', url: PROJECT, title: 'Caissa trainer', named: true, fromConversation: true });
  });

  it('gives an address with no words in it the plain title, and marks it as not a name worth offering', () => {
    expect(readChatGptAddress('https://chatgpt.com/g/g-p-abc123/project')).toMatchObject({ kind: 'project', title: 'ChatGPT Project', named: false });
  });

  it('keeps an address of a form it does not recognise exactly as pasted', () => {
    expect(readChatGptAddress('https://chatgpt.com/library?x=1#top')).toEqual({ kind: 'as-pasted', url: 'https://chatgpt.com/library' });
  });

  it('refuses what is not a ChatGPT Project, with the reason in words', () => {
    expect(readChatGptAddress('https://chatgpt.com/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b')).toEqual({
      kind: 'invalid', message: 'That is a single conversation outside any project. Open the project in ChatGPT and copy the address of its project page.',
    });
    expect(readChatGptAddress('https://chatgpt.com/g/g-xyz789/c/6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b')).toEqual({ kind: 'invalid', message: 'That is a conversation with a custom GPT, not a ChatGPT Project.' });
    expect(readChatGptAddress('https://chatgpt.com/')).toMatchObject({ kind: 'invalid', message: expect.stringContaining('home page') });
    expect(readChatGptAddress('https://chatgpt.com/share/abc')).toMatchObject({ kind: 'invalid', message: expect.stringContaining('share link') });
    expect(readChatGptAddress('https://example.com/g/g-p-abc/project')).toEqual({ kind: 'invalid', message: 'Only chatgpt.com addresses are accepted.' });
    expect(readChatGptAddress('http://chatgpt.com/g/g-p-abc/project')).toEqual({ kind: 'invalid', message: 'Only https addresses are accepted.' });
  });

  it('knows the title an address gives by itself, so a typed title can be told from it', () => {
    expect(automaticTitleOf(PROJECT)).toBe('Caissa trainer');
    expect(automaticTitleOf('https://example.com/')).toBeNull();
  });
});

describe('a GitHub repository', () => {
  it('reads owner/repo and the common ways of pasting one', () => {
    expect(readGithub('')).toEqual({ kind: 'empty' });
    expect(readGithub('acme/billing')).toEqual({ kind: 'ok', value: 'acme/billing', changed: false });
    expect(readGithub('https://github.com/acme/billing.git')).toEqual({ kind: 'ok', value: 'acme/billing', changed: true });
    expect(readGithub('git@github.com:acme/billing.git')).toEqual({ kind: 'ok', value: 'acme/billing', changed: true });
    expect(readGithub('not a repo')).toEqual({ kind: 'invalid', message: 'Use the form owner/repo, for example acme/git-manager.' });
  });

  it('is called by the part after the slash', () => {
    expect(repoName('acme/git-manager')).toBe('git-manager');
  });
});

describe('a folder', () => {
  it('reads a Windows path and cleans it', () => {
    expect(readFolder('C:\\Dev\\App\\', 'win32', null)).toEqual({ kind: 'ok', env: 'win', path: 'C:\\Dev\\App', note: null });
    expect(readFolder('"c:/dev/app"', 'win32', null)).toMatchObject({ kind: 'ok', env: 'win', path: 'C:\\dev\\app' });
  });

  it('reads a WSL share as a path inside that distribution', () => {
    expect(readFolder('\\\\wsl$\\Ubuntu\\home\\me\\app', 'win32', null)).toEqual({ kind: 'ok', env: 'wsl:Ubuntu', path: '/home/me/app', note: 'Read as a path inside WSL (Ubuntu).' });
  });

  it('asks which distribution a Linux path on Windows is in, and reads it once told', () => {
    expect(readFolder('/home/me/app', 'win32', null)).toEqual({ kind: 'needs-distro', message: 'This looks like a Linux path. Choose which WSL distribution it belongs to.' });
    expect(readFolder('/home/me/app', 'win32', 'wsl:Debian')).toMatchObject({ kind: 'ok', env: 'wsl:Debian', path: '/home/me/app' });
  });

  it('reads a Linux path on Linux with no question', () => {
    expect(readFolder('/home/me/app', 'linux', null)).toEqual({ kind: 'ok', env: 'posix', path: '/home/me/app', note: null });
  });

  it('explains a path it cannot use', () => {
    expect(readFolder('', 'win32', null)).toEqual({ kind: 'empty' });
    expect(readFolder('relative/path', 'win32', null)).toEqual({ kind: 'invalid', message: 'Enter an absolute path (for example C:\\Dev\\App or /home/me/app).' });
  });

  it('is called by its last segment, and a drive on its own is not a name', () => {
    expect(folderName('C:\\Dev\\Billing service')).toBe('Billing service');
    expect(folderName('/home/me/app')).toBe('app');
    expect(folderName('C:\\')).toBe('');
    expect(folderName('/')).toBe('');
  });
});

describe('the name offered for a new project', () => {
  it('is the title of the ChatGPT Project, the name of the repository or the name of the folder', () => {
    expect(suggestName(input({ source: 'chatgpt', address: PROJECT }))).toBe('Caissa trainer');
    expect(suggestName(input({ source: 'github', repo: 'https://github.com/acme/git-manager.git' }))).toBe('git-manager');
    expect(suggestName(input({ source: 'folder', folder: 'C:\\Dev\\Billing service' }))).toBe('Billing service');
  });

  it('is nothing where the source has no name to give', () => {
    expect(suggestName(input({ source: 'empty' }))).toBe('');
    expect(suggestName(input({ source: 'chatgpt', address: 'https://chatgpt.com/g/g-p-abc123/project' }))).toBe(''); // "ChatGPT Project" is not a name
    expect(suggestName(input({ source: 'chatgpt', address: 'https://chatgpt.com/library' }))).toBe('');
    expect(suggestName(input({ source: 'github', repo: 'nope' }))).toBe('');
    expect(suggestName(input({ source: 'folder', folder: '/home/me/app' }))).toBe(''); // still waiting for the distribution
  });

  it('follows the source that is chosen, not the others', () => {
    expect(suggestName(input({ source: 'github', address: PROJECT, repo: 'acme/billing', folder: 'C:\\Dev\\Other' }))).toBe('billing');
  });
});

describe('what creating sends', () => {
  it('from a ChatGPT Project: its address as pasted, nothing else', () => {
    expect(planCreate(input({ source: 'chatgpt', address: `  ${PROJECT}  `, name: ' Caissa ' }))).toEqual({ ok: true, body: { name: 'Caissa', chatgptProject: { url: PROJECT } } });
    // A conversation inside the project is sent as pasted: the core turns it into the project page.
    expect(planCreate(input({ source: 'chatgpt', address: CHAT_IN_PROJECT }))).toEqual({ ok: true, body: { name: 'Billing', chatgptProject: { url: CHAT_IN_PROJECT } } });
  });

  it('from a GitHub repository: owner/repo, and no folder', () => {
    const plan = planCreate(input({ source: 'github', repo: 'https://github.com/acme/billing.git' }));
    expect(plan).toEqual({ ok: true, body: { name: 'Billing', githubRepo: 'acme/billing' } });
    expect(plan.ok && 'roots' in plan.body).toBe(false);
  });

  it('from a local folder: the cleaned path and its environment', () => {
    expect(planCreate(input({ source: 'folder', folder: 'C:\\Dev\\Billing\\' }))).toEqual({ ok: true, body: { name: 'Billing', roots: [{ path: 'C:\\Dev\\Billing', env: 'win' }] } });
    expect(planCreate(input({ source: 'folder', folder: '/home/me/billing', distro: 'wsl:Ubuntu' }))).toEqual({ ok: true, body: { name: 'Billing', roots: [{ path: '/home/me/billing', env: 'wsl:Ubuntu' }] } });
  });

  it('from nothing: the name', () => {
    expect(planCreate(input({ source: 'empty', address: PROJECT, repo: 'acme/x', folder: 'C:\\x' }))).toEqual({ ok: true, body: { name: 'Billing' } });
  });

  it('says what is wrong with the name and with the one thing the source needs, and only that', () => {
    expect(planCreate(input({ source: 'empty', name: '' }))).toEqual({ ok: false, errors: { name: 'Give the project a name.' } });
    expect(planCreate(input({ source: 'chatgpt', address: '', name: '' }))).toEqual({ ok: false, errors: { name: 'Give the project a name.', source: 'Paste the address of the ChatGPT Project.' } });
    expect(planCreate(input({ source: 'github', repo: '' }))).toEqual({ ok: false, errors: { source: 'Enter the repository as owner/repo.' } });
    expect(planCreate(input({ source: 'github', repo: 'not a repo' }))).toEqual({ ok: false, errors: { source: 'Use the form owner/repo, for example acme/git-manager.' } });
    expect(planCreate(input({ source: 'folder', folder: '' }))).toEqual({ ok: false, errors: { source: 'Enter the folder that holds the project.' } });
    expect(planCreate(input({ source: 'folder', folder: '/home/me/app' }))).toEqual({
      ok: false, errors: { source: 'Choose which WSL distribution this folder is in, or clear the folder field.' },
    });
    // A source that is not chosen is never asked about.
    expect(planCreate(input({ source: 'empty', address: 'nonsense', repo: 'nonsense', folder: 'nonsense' }))).toEqual({ ok: true, body: { name: 'Billing' } });
  });
});

describe('where a failure of the core is shown', () => {
  it('beside the field it is about, and once for the dialog when it is about none', () => {
    expect(failureField({ code: 'root_not_found', details: { field: 'path' } })).toBe('source');
    expect(failureField({ code: 'root_in_use', details: { projectId: 'p', projectName: 'Other' } })).toBe('source');
    expect(failureField({ code: 'root_exists' })).toBe('source');
    expect(failureField({ code: 'needs_env' })).toBe('source');
    expect(failureField({ code: 'invalid_chatgpt_project', details: { field: 'chatgptProject' } })).toBe('source');
    expect(failureField({ code: 'invalid_repo', details: { field: 'githubRepo' } })).toBe('source');
    expect(failureField({ code: 'invalid_name', details: { field: 'name' } })).toBe('name');
    expect(failureField({ code: 'network' })).toBe('general');
    expect(failureField({ code: 'http_500', details: null })).toBe('general');
  });
});
