// Which page of ChatGPT is remembered for a project: the scope filter, the pages that never count, and the guard for the moment right
// after another project was selected (the one view still shows the previous project's page and goes on reporting it).
import { describe, expect, it } from 'vitest';
import type { ChatGptViewStatus } from '@minisumma/shared';
import { ChatGptRecorder, recordableAddress } from '../../src/renderer/src/app/chatgptRecorder';

const SCOPE_A = 'g-p-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-alpha';
const SCOPE_B = 'g-p-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-beta';
const uuid = (c: string): string => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const chatIn = (scope: string, c: string): string => `https://chatgpt.com/g/${scope}/c/${uuid(c)}`;
const projectPage = (scope: string): string => `https://chatgpt.com/g/${scope}/project`;
const plain = (c: string): string => `https://chatgpt.com/c/${uuid(c)}`;
const state = (url: string | null, status: ChatGptViewStatus = 'ready') => ({ url, status });

const A = { id: 'prj_a', scopeId: SCOPE_A };
const B = { id: 'prj_b', scopeId: SCOPE_B };
const FREE = { id: 'prj_free', scopeId: null };

describe('recordableAddress: which pages belong to a project', () => {
  it('a linked project records only the pages of its own ChatGPT Project: its conversations and its project page', () => {
    expect(recordableAddress(chatIn(SCOPE_A, '1'), A)).toBe(chatIn(SCOPE_A, '1'));
    expect(recordableAddress(projectPage(SCOPE_A), A)).toBe(projectPage(SCOPE_A));
    expect(recordableAddress(chatIn(SCOPE_B, '2'), A)).toBeNull();
    expect(recordableAddress(projectPage(SCOPE_B), A)).toBeNull();
    expect(recordableAddress(plain('3'), A)).toBeNull(); // a conversation outside any project is not this project's
  });

  it('a project without a link records conversations, not project pages', () => {
    expect(recordableAddress(plain('3'), FREE)).toBe(plain('3'));
    expect(recordableAddress(chatIn(SCOPE_B, '2'), FREE)).toBe(chatIn(SCOPE_B, '2'));
    expect(recordableAddress(projectPage(SCOPE_B), FREE)).toBeNull();
  });

  it('never records the home page, settings, sign-in, a share link, another site or nothing', () => {
    for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/settings', 'https://chatgpt.com/share/abc', 'https://auth.openai.com/log-in', 'https://example.com/c/' + uuid('4'), null]) {
      expect(recordableAddress(url, A), String(url)).toBeNull();
      expect(recordableAddress(url, FREE), String(url)).toBeNull();
    }
  });

  it('drops the query and the fragment', () => {
    expect(recordableAddress(`${chatIn(SCOPE_A, '1')}?model=x#top`, A)).toBe(chatIn(SCOPE_A, '1'));
  });
});

describe('the recorder after a project switch', () => {
  it('records nothing while the view still shows the previous project\'s page, then the page the new project asked for, then the person\'s own navigation', () => {
    const r = new ChatGptRecorder();
    r.observe(state(chatIn(SCOPE_A, '1'))); // the view shows A's page
    const token = r.begin(FREE); // another project, unlinked (its filter would accept A's conversation)
    r.expect(token, plain('9'));
    expect(r.observe(state(chatIn(SCOPE_A, '1')))).toBeNull(); // still A's page
    expect(r.observe(state(chatIn(SCOPE_A, '1'), 'loading'))).toBeNull();
    expect(r.observe(state(plain('9'), 'loading'))).toBeNull(); // arrived but not ready
    expect(r.observe(state(plain('9')))).toEqual({ projectId: 'prj_free', url: plain('9') });
    expect(r.observe(state(plain('8')))).toEqual({ projectId: 'prj_free', url: plain('8') }); // the person navigated afterwards
  });

  it('a late report of the previous page after the switch is never taken for the new project (unlinked project, nothing asked for)', () => {
    const r = new ChatGptRecorder();
    r.observe(state(plain('1')));
    r.begin(FREE);
    expect(r.observe(state(plain('1')))).toBeNull();
    expect(r.observe(state(plain('1')))).toBeNull();
    expect(r.observe(state(plain('2')))).toEqual({ projectId: 'prj_free', url: plain('2') }); // the view moved on: the person went somewhere
  });

  it('a request that ends on another page (a redirect) still arms, and an error page is never recorded', () => {
    const r = new ChatGptRecorder();
    r.observe(state(plain('1')));
    const token = r.begin(FREE);
    r.expect(token, plain('5'));
    expect(r.observe(state('https://chatgpt.com/auth/login', 'login_required'))).toBeNull();
    expect(r.observe(state(plain('5'), 'error'))).toBeNull();
    expect(r.observe(state(plain('5')))).toEqual({ projectId: 'prj_free', url: plain('5') });
  });

  it('a finished owner records nothing, and a new owner does not inherit the old one\'s arming', () => {
    const r = new ChatGptRecorder();
    const first = r.begin(A);
    r.arm(first);
    expect(r.observe(state(chatIn(SCOPE_A, '1')))).toEqual({ projectId: 'prj_a', url: chatIn(SCOPE_A, '1') });
    r.end(first);
    expect(r.observe(state(chatIn(SCOPE_A, '2')))).toBeNull();
    const second = r.begin(B);
    r.expect(second, projectPage(SCOPE_B));
    expect(r.observe(state(chatIn(SCOPE_A, '2')))).toBeNull(); // A's page, B is the owner
    expect(r.observe(state(projectPage(SCOPE_B)))).toEqual({ projectId: 'prj_b', url: projectPage(SCOPE_B) });
  });

  it('calls with the token of a finished owner change nothing', () => {
    const r = new ChatGptRecorder();
    const old = r.begin(A);
    const now = r.begin(B);
    r.arm(old); // a late call of the previous project
    r.expect(old, chatIn(SCOPE_A, '1'));
    r.expect(now, projectPage(SCOPE_B));
    expect(r.observe(state(chatIn(SCOPE_A, '1')))).toBeNull(); // B is waiting for its own page: this is not it, and nothing was armed by `old`
  });

  it('with the page already on screen, arm() makes what comes next the person\'s', () => {
    const r = new ChatGptRecorder();
    r.observe(state(chatIn(SCOPE_A, '1')));
    const token = r.begin(A);
    r.arm(token);
    expect(r.observe(state(chatIn(SCOPE_A, '1')))).toEqual({ projectId: 'prj_a', url: chatIn(SCOPE_A, '1') });
  });

  it('the scope filter still holds after arming: a page of another ChatGPT Project is not recorded', () => {
    const r = new ChatGptRecorder();
    const token = r.begin(A);
    r.arm(token);
    expect(r.observe(state(chatIn(SCOPE_B, '2')))).toBeNull();
    expect(r.observe(state('https://chatgpt.com/'))).toBeNull();
    expect(r.observe(state(chatIn(SCOPE_A, '3')))).toEqual({ projectId: 'prj_a', url: chatIn(SCOPE_A, '3') });
  });

  it('retarget keeps the arming when the linked project changes while the pane is open', () => {
    const r = new ChatGptRecorder();
    const token = r.begin(FREE);
    r.arm(token);
    r.retarget(token, { id: 'prj_free', scopeId: SCOPE_A });
    expect(r.observe(state(plain('7')))).toBeNull(); // now linked: a plain conversation is outside the project
    expect(r.observe(state(chatIn(SCOPE_A, '7')))).toEqual({ projectId: 'prj_free', url: chatIn(SCOPE_A, '7') });
  });
});
