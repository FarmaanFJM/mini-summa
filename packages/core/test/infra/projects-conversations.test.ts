import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_A, CHAT_B, CHAT_C, expectPlainText, failure, makeProjectsEnv } from './part1-fixtures.ts';
import type { ProjectsEnv } from './part1-fixtures.ts';

let env: ProjectsEnv;
afterEach(() => env?.base.close());
const setup = () => { env = makeProjectsEnv(); return env.projects; };

const UUID_UPPER = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const UUID_LOWER = UUID_UPPER.toLowerCase();

describe('adding a conversation', () => {
  it('stores the normalized address and what was pasted, with a title suggested from the address', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const pasted = `  https://chat.openai.com/c/${UUID_UPPER}/?model=gpt-4o#section  `;
    const c = projects.conversations.add(p.id, { url: pasted });
    expect(c).toMatchObject({
      projectId: p.id,
      url: `https://chatgpt.com/c/${UUID_LOWER}`,
      originalUrl: pasted.trim(),
      kind: 'chat',
      chatgptConversationId: UUID_LOWER,
      title: 'ChatGPT conversation aaaaaaaa',
      verification: 'unverified',
      verifiedAt: null,
      verifiedTitle: null,
      note: null,
      position: 0,
      createdAt: '2026-03-01T12:00:00.000Z',
    });
    expect(c.id).toMatch(/^cnv_[0-9a-f]{16}$/);
    expect(projects.conversations.get(c.id)).toEqual(c);
    expect(projects.conversations.require(c.id)).toEqual(c);
    expect(projects.conversations.list(p.id)).toEqual([c]);
  });

  it('understands project chats, custom GPT chats, project pages and the landing page', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const add = (url: string) => projects.conversations.add(p.id, { url });
    expect(add(`https://chatgpt.com/g/g-p-abc123/c/${UUID_UPPER}`)).toMatchObject({ kind: 'project_chat', url: `https://chatgpt.com/g/g-p-abc123/c/${UUID_LOWER}`, chatgptConversationId: UUID_LOWER });
    expect(add(`https://chatgpt.com/g/g-xyz/c/${UUID_LOWER}`)).toMatchObject({ kind: 'gpt_chat' });
    expect(add('https://chatgpt.com/g/g-p-abc123/project')).toMatchObject({ kind: 'project', chatgptConversationId: null, title: 'ChatGPT project' });
    expect(add('chatgpt.com')).toMatchObject({ kind: 'other', url: 'https://chatgpt.com/', title: 'ChatGPT' });
  });

  it('uses the title and note it is given (trimmed), and a suggestion when the title is blank', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const named = projects.conversations.add(p.id, { url: CHAT_A, title: '  Design review  ', note: '  weekly  ' });
    expect(named).toMatchObject({ title: 'Design review', note: 'weekly' });
    const blank = projects.conversations.add(p.id, { url: CHAT_B, title: '   ', note: '' });
    expect(blank).toMatchObject({ title: 'ChatGPT conversation 22222222', note: null });
    expect(failure(() => projects.conversations.add(p.id, { url: CHAT_C, title: 'x'.repeat(201) })).status).toBe(400);
  });

  it('numbers conversations in the order they were added', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const ids = [CHAT_A, CHAT_B, CHAT_C].map((url) => projects.conversations.add(p.id, { url }).id);
    expect(projects.conversations.list(p.id).map((c) => [c.id, c.position])).toEqual(ids.map((id, i) => [id, i]));
  });

  it('rejects addresses that are not ChatGPT conversations, with the reason in plain words', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const cases: [string, string][] = [
      ['', 'empty'],
      ['http://chatgpt.com/c/' + UUID_LOWER, 'not_https'],
      ['javascript:alert(1)', 'not_https'],
      ['https://example.com/c/' + UUID_LOWER, 'host_not_allowed'],
      ['https://chatgpt.com.evil.test/c/' + UUID_LOWER, 'host_not_allowed'],
      ['not a url at all', 'unparsable'],
    ];
    for (const [url, reason] of cases) {
      const err = failure(() => projects.conversations.add(p.id, { url }));
      expect(err, url).toMatchObject({ status: 400, code: 'invalid_conversation_url', details: { reason } });
      expect(err.message.length).toBeGreaterThan(15);
      expectPlainText(err.message);
    }
    expect(projects.conversations.list(p.id)).toEqual([]);
    expect(env.base.eventsOf('conversation.upserted')).toHaveLength(0);
  });

  it('refuses a project that does not exist', () => {
    const projects = setup();
    expect(failure(() => projects.conversations.add('prj_nope', { url: CHAT_A })).status).toBe(404);
    expect(projects.conversations.list('prj_nope')).toEqual([]);
    expect(projects.conversations.get('cnv_nope')).toBeNull();
    expect(failure(() => projects.conversations.require('cnv_nope')).status).toBe(404);
  });

  it('refuses the same page twice in a project, however it was spelled, but allows it in another project', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const q = projects.create({ name: 'Q' });
    const page = `https://chatgpt.com/c/${UUID_LOWER}`;
    const first = projects.conversations.add(p.id, { url: page, title: 'Original' });
    for (const again of [page, `${page}?model=x`, `${page}/`, page.replace('chatgpt.com', 'chat.openai.com'), `https://www.chatgpt.com/c/${UUID_UPPER}#end`]) {
      const err = failure(() => projects.conversations.add(p.id, { url: again }));
      expect(err, again).toMatchObject({ status: 409, code: 'conversation_exists', details: { conversationId: first.id } });
      expect(err.message).toContain('"Original"');
      expectPlainText(err.message);
    }
    expect(projects.conversations.list(p.id)).toHaveLength(1);
    expect(projects.conversations.add(q.id, { url: page }).projectId).toBe(q.id);
  });
});

describe('the preferred conversation', () => {
  it('is the first conversation of a project, automatically; later ones are not', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const first = projects.conversations.add(p.id, { url: CHAT_A });
    expect(projects.require(p.id).preferredConversationId).toBe(first.id);
    const second = projects.conversations.add(p.id, { url: CHAT_B });
    const third = projects.conversations.add(p.id, { url: CHAT_C, makePreferred: false });
    expect(projects.require(p.id).preferredConversationId).toBe(first.id);
    expect([second.id, third.id]).not.toContain(first.id);
  });

  it('can be set when adding, and later by setPreferred, and cleared with null', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const a = projects.conversations.add(p.id, { url: CHAT_A });
    const b = projects.conversations.add(p.id, { url: CHAT_B, makePreferred: true });
    expect(projects.require(p.id).preferredConversationId).toBe(b.id);
    expect(projects.conversations.setPreferred(p.id, a.id).preferredConversationId).toBe(a.id);
    expect(projects.conversations.setPreferred(p.id, null).preferredConversationId).toBeNull();
    expect(projects.require(p.id).preferredConversationId).toBeNull();
  });

  it('is refused for a conversation of another project or one that does not exist', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const q = projects.create({ name: 'Q' });
    const own = projects.conversations.add(p.id, { url: CHAT_A });
    const foreign = projects.conversations.add(q.id, { url: CHAT_B });
    expect(failure(() => projects.conversations.setPreferred(p.id, foreign.id))).toMatchObject({ status: 400, code: 'conversation_wrong_project' });
    expect(failure(() => projects.conversations.setPreferred(p.id, 'cnv_nope')).status).toBe(404);
    expect(failure(() => projects.conversations.setPreferred('prj_nope', own.id)).status).toBe(404);
    expect(projects.require(p.id).preferredConversationId).toBe(own.id);
  });

  it('is cleared when that conversation is removed, and no other conversation takes its place', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const a = projects.conversations.add(p.id, { url: CHAT_A });
    const b = projects.conversations.add(p.id, { url: CHAT_B });
    expect(projects.require(p.id).preferredConversationId).toBe(a.id);
    projects.conversations.remove(a.id);
    expect(projects.require(p.id).preferredConversationId).toBeNull();
    expect(projects.conversations.list(p.id).map((c) => c.id)).toEqual([b.id]);
    // adding another one does not turn it preferred either, because the project already had conversations
    projects.conversations.add(p.id, { url: CHAT_C });
    expect(projects.require(p.id).preferredConversationId).toBeNull();
  });

  it('leaves the preference alone when another conversation is removed', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const a = projects.conversations.add(p.id, { url: CHAT_A });
    const b = projects.conversations.add(p.id, { url: CHAT_B });
    const before = env.base.eventsOf('project.upserted').length;
    projects.conversations.remove(b.id);
    expect(projects.require(p.id).preferredConversationId).toBe(a.id);
    expect(env.base.eventsOf('project.upserted')).toHaveLength(before);
  });

  it('becomes the new conversation again once a project has none left', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const a = projects.conversations.add(p.id, { url: CHAT_A });
    projects.conversations.remove(a.id);
    const b = projects.conversations.add(p.id, { url: CHAT_B });
    expect(projects.require(p.id).preferredConversationId).toBe(b.id);
  });
});

describe('changing a conversation', () => {
  it('edits title and note without touching verification', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const c = projects.conversations.add(p.id, { url: CHAT_A });
    projects.conversations.setVerification(c.id, { verification: 'verified', title: 'Sprint planning' });
    env.base.clock.advance(3000);
    const u = projects.conversations.update(c.id, { title: ' Sprint ', note: ' mine ' });
    expect(u).toMatchObject({ title: 'Sprint', note: 'mine', verification: 'verified', verifiedTitle: 'Sprint planning', updatedAt: '2026-03-01T12:00:03.000Z' });
    expect(projects.conversations.update(c.id, { note: null }).note).toBeNull();
    expect(projects.conversations.update(c.id, { title: '' }).title).toBe('ChatGPT conversation 11111111');
  });

  it('resets verification to "unverified" when the address changes', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const c = projects.conversations.add(p.id, { url: CHAT_A, title: 'My chat' });
    projects.conversations.setVerification(c.id, { verification: 'verified', title: 'Some title' });
    const u = projects.conversations.update(c.id, { url: `${CHAT_B}?x=1` });
    expect(u).toMatchObject({ url: CHAT_B, originalUrl: `${CHAT_B}?x=1`, chatgptConversationId: CHAT_B.slice(-36), verification: 'unverified', verifiedAt: null, verifiedTitle: null, title: 'My chat' });
    expect(projects.conversations.get(c.id)).toEqual(u);
  });

  it('keeps verification when the new spelling is the same page', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const c = projects.conversations.add(p.id, { url: CHAT_A });
    const verified = projects.conversations.setVerification(c.id, { verification: 'verified', title: 'T' });
    const before = env.base.eventsOf('conversation.upserted').length;
    expect(projects.conversations.update(c.id, { url: `${CHAT_A}?model=x#top` })).toEqual(verified);
    expect(env.base.eventsOf('conversation.upserted')).toHaveLength(before);
  });

  it('renames a title that was only the suggestion for the old address, but not a title the user chose', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const auto = projects.conversations.add(p.id, { url: CHAT_A });
    const chosen = projects.conversations.add(p.id, { url: CHAT_B, title: 'Chosen' });
    expect(projects.conversations.update(auto.id, { url: CHAT_C }).title).toBe('ChatGPT conversation 33333333');
    expect(projects.conversations.update(chosen.id, { url: CHAT_A }).title).toBe('Chosen');
  });

  it('refuses an address that another conversation of the project already has', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const a = projects.conversations.add(p.id, { url: CHAT_A, title: 'First' });
    const b = projects.conversations.add(p.id, { url: CHAT_B });
    expect(failure(() => projects.conversations.update(b.id, { url: CHAT_A }))).toMatchObject({ status: 409, code: 'conversation_exists', details: { conversationId: a.id } });
    expect(failure(() => projects.conversations.update(b.id, { url: 'https://example.com/x' })).status).toBe(400);
    expect(projects.conversations.get(b.id)?.url).toBe(CHAT_B);
  });

  it('records every verification outcome with the time and the page title seen', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const c = projects.conversations.add(p.id, { url: CHAT_A });
    env.base.clock.set('2026-03-02T08:00:00.000Z');
    expect(projects.conversations.setVerification(c.id, { verification: 'verified', title: 'Real title' }))
      .toMatchObject({ verification: 'verified', verifiedAt: '2026-03-02T08:00:00.000Z', verifiedTitle: 'Real title', updatedAt: '2026-03-02T08:00:00.000Z' });
    env.base.clock.set('2026-03-02T09:00:00.000Z');
    for (const verification of ['mismatch', 'unreachable', 'login_required'] as const) {
      expect(projects.conversations.setVerification(c.id, { verification })).toMatchObject({ verification, verifiedAt: '2026-03-02T09:00:00.000Z', verifiedTitle: null });
    }
    expect(projects.conversations.setVerification(c.id, { verification: 'mismatch', title: 'Wrong page' }).verifiedTitle).toBe('Wrong page');
    expect(projects.conversations.setVerification(c.id, { verification: 'unverified', title: 'ignored' })).toMatchObject({ verification: 'unverified', verifiedAt: null, verifiedTitle: null });
    expect(failure(() => projects.conversations.setVerification(c.id, { verification: 'fine' as never })).status).toBe(400);
    expect(failure(() => projects.conversations.setVerification('cnv_nope', { verification: 'verified' })).status).toBe(404);
  });
});

describe('events', () => {
  it('announces the conversation first and the project change it caused second, after the data was saved', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const seen: string[] = [];
    env.base.bus.subscribe((_seq, e) => {
      if (e.type === 'conversation.upserted') seen.push(`conversation:${env.base.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE id = ?', [e.conversation.id])?.n}`);
      if (e.type === 'project.upserted') seen.push(`project:${e.project.preferredConversationId === null ? 'none' : 'preferred'}`);
    });
    const c = projects.conversations.add(p.id, { url: CHAT_A });
    expect(seen).toEqual(['conversation:1', 'project:preferred']);
    expect(env.base.eventsOf('conversation.upserted').at(-1)?.conversation).toEqual(c);
  });

  it('announces removal with the project id, and the cleared preference after it', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const c = projects.conversations.add(p.id, { url: CHAT_A });
    const mark = env.base.events.length;
    projects.conversations.remove(c.id);
    const after = env.base.events.slice(mark).map((e) => e.event);
    expect(after.map((e) => e.type)).toEqual(['conversation.removed', 'project.upserted']);
    expect(after[0]).toEqual({ type: 'conversation.removed', id: c.id, projectId: p.id });
    expect(after[1]).toMatchObject({ type: 'project.upserted', project: { id: p.id, preferredConversationId: null } });
    expect(failure(() => projects.conversations.remove(c.id)).status).toBe(404);
  });

  it('announces updates and verification results', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const c = projects.conversations.add(p.id, { url: CHAT_A });
    const u = projects.conversations.update(c.id, { title: 'Renamed' });
    const v = projects.conversations.setVerification(c.id, { verification: 'verified', title: 'T' });
    const last = env.base.eventsOf('conversation.upserted').slice(-2).map((e) => e.conversation);
    expect(last).toEqual([u, v]);
  });
});

describe('what removing a conversation leaves alone', () => {
  it('clears the explicit conversation of a session binding but keeps the binding', () => {
    const projects = setup();
    const p = projects.create({ name: 'P' });
    const c = projects.conversations.add(p.id, { url: CHAT_A });
    env.base.db.run("INSERT INTO session_bindings (session_key, project_id, conversation_id, source, created_at, updated_at) VALUES ('win|s1', ?, ?, 'managed', 't', 't')", [p.id, c.id]);
    projects.conversations.remove(c.id);
    expect(env.base.db.get('SELECT project_id, conversation_id FROM session_bindings WHERE session_key = ?', ['win|s1'])).toEqual({ project_id: p.id, conversation_id: null });
  });
});
