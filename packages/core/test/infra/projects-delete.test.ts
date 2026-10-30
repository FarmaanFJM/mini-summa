import type { Db } from '@minisumma/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_A, CHAT_B, failure, makeProjectsEnv } from './part1-fixtures.ts';
import type { ProjectsEnv } from './part1-fixtures.ts';

let env: ProjectsEnv;
afterEach(() => env?.base.close());

interface Seeded { projectId: string; conversationIds: string[]; sessionKeys: string[] }

/** One or two rows in every table that can hang off a project. Returns the session keys of the projection rows. */
function seedWorkflow(db: Db, projectId: string, tag: string, conversationIds: string[]): Seeded {
  const at = '2026-02-01T00:00:00.000Z';
  const sessionKeys = [`win|${tag}-s1`, `wsl:Ubuntu|${tag}-s2`];
  for (const n of [1, 2]) {
    db.run(
      `INSERT INTO reports (id, session_key, env, session_id, generation, project_id, project_name, task_id, task_title, declared_status, source, body, body_sha256, note, captured_at)
       VALUES (?, ?, 'win', 's', 1, ?, ?, 't', ?, 'complete', 'marker', 'body', 'sha', 'n', ?)`,
      [`rpt_${tag}${n}`, sessionKeys[0], projectId, tag, `Task ${tag}${n}`, at],
    );
    db.run(
      `INSERT INTO deliveries (id, report_id, project_id, project_name, session_key, task_title, state, destination_json, state_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'task', 'ready_for_handoff', ?, ?, ?, ?)`,
      [`dlv_${tag}${n}`, `rpt_${tag}${n}`, projectId, tag, sessionKeys[0], JSON.stringify({ conversationId: conversationIds[0] ?? null }), at, at, at],
    );
    db.run("INSERT INTO delivery_events (id, delivery_id, at, type, actor_json) VALUES (?, ?, ?, 'created', '{\"kind\":\"system\"}')", [`evt_${tag}${n}`, `dlv_${tag}${n}`, at]);
  }
  db.run(
    `INSERT INTO report_candidates (id, session_key, env, session_id, generation, project_id, reason, body, body_sha256, captured_at)
     VALUES (?, ?, 'win', 's', 1, ?, 'no marker', 'b', 'sha', ?)`,
    [`cand_${tag}`, sessionKeys[0], projectId, at],
  );
  db.run(
    "INSERT INTO activity (id, at, project_id, project_name, source, type, severity, title) VALUES (?, ?, ?, ?, 'claude', 'report_ready', 'info', 'Report ready')",
    [`act_${tag}`, at, projectId, tag],
  );
  db.run(
    "INSERT INTO notifications (id, activity_id, project_id, at, title, body, native, push, target_json, dedupe_key) VALUES (?, ?, ?, ?, 't', 'b', 'sent', 'sent', '{}', ?)",
    [`ntf_${tag}`, `act_${tag}`, projectId, at, `dedupe-${tag}`],
  );
  db.run(
    `INSERT INTO pending_actions (id, kind, status, project_id, session_key, generation, summary, created_at, created_by_json, approvable_by, expires_at)
     VALUES (?, 'claude_prompt', 'pending', ?, ?, 1, 's', ?, '{"kind":"desktop"}', 'desktop', ?)`,
    [`act_p_${tag}`, projectId, sessionKeys[0], at, at],
  );
  db.run("INSERT INTO session_bindings (session_key, project_id, conversation_id, source, created_at, updated_at) VALUES (?, ?, ?, 'managed', ?, ?)", [sessionKeys[0], projectId, conversationIds[0] ?? null, at, at]);
  db.run("INSERT INTO session_bindings (session_key, project_id, conversation_id, source, created_at, updated_at) VALUES (?, ?, NULL, 'manual', ?, ?)", [sessionKeys[1], projectId, at, at]);
  db.run(
    "INSERT INTO managed_sessions (session_key, env, session_id, project_id, cwd, mode, status, started_at, app_run_id) VALUES (?, 'win', ?, ?, 'C:\\x', 'new', 'running', ?, 'run1')",
    [sessionKeys[0], `${tag}-s1`, projectId, at],
  );
  for (const key of sessionKeys) {
    db.run(
      "INSERT INTO sessions_projection (session_key, env, session_id, project_id, origin, availability, state, view_json, updated_at) VALUES (?, 'win', ?, ?, 'managed', 'live', 'idle', '{}', ?)",
      [key, key.split('|')[1], projectId, at],
    );
  }
  return { projectId, conversationIds, sessionKeys };
}

type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;

const TABLES = [
  'projects', 'project_roots', 'conversations', 'reports', 'report_candidates', 'deliveries', 'delivery_events', 'activity',
  'notifications', 'pending_actions', 'session_bindings', 'managed_sessions', 'sessions_projection',
  'kv', 'devices', 'pairing_offers', 'raw_events', 'hook_installs', 'idempotency',
];

/** The whole content of every table that matters, in insertion order. */
function snapshot(db: Db): Snapshot {
  return Object.fromEntries(TABLES.map((t) => [t, db.all<Row>(`SELECT * FROM ${t} ORDER BY rowid`)]));
}

/**
 * What the database must look like after project `id` is deleted: the same tables, minus the rows that belonged to it.
 * Rows that belong to nobody (project_id NULL) and rows of other projects stay.
 */
function expectedWithout(before: Snapshot, id: string): Snapshot {
  const deliveryIds = new Set(before.deliveries.filter((d) => d.project_id === id).map((d) => d.id));
  const out: Snapshot = {};
  for (const [table, rows] of Object.entries(before)) {
    if (table === 'projects') out[table] = rows.filter((r) => r.id !== id);
    else if (table === 'delivery_events') out[table] = rows.filter((r) => !deliveryIds.has(r.delivery_id));
    else if ('project_id' in (rows[0] ?? {})) out[table] = rows.filter((r) => r.project_id !== id);
    else out[table] = rows;
  }
  return out;
}

/** Rows of one project in the tables that carry a project id, for "does it have something to delete" checks. */
function rowsOfProject(db: Db, projectId: string): Record<string, unknown[]> {
  const q = (sql: string): unknown[] => db.all(sql, [projectId]);
  return {
    projects: q('SELECT * FROM projects WHERE id = ? ORDER BY id'),
    project_roots: q('SELECT * FROM project_roots WHERE project_id = ? ORDER BY id'),
    conversations: q('SELECT * FROM conversations WHERE project_id = ? ORDER BY id'),
    reports: q('SELECT * FROM reports WHERE project_id = ? ORDER BY id'),
    report_candidates: q('SELECT * FROM report_candidates WHERE project_id = ? ORDER BY id'),
    deliveries: q('SELECT * FROM deliveries WHERE project_id = ? ORDER BY id'),
    delivery_events: q('SELECT e.* FROM delivery_events e JOIN deliveries d ON d.id = e.delivery_id WHERE d.project_id = ? ORDER BY e.id'),
    activity: q('SELECT * FROM activity WHERE project_id = ? ORDER BY id'),
    notifications: q('SELECT * FROM notifications WHERE project_id = ? ORDER BY id'),
    pending_actions: q('SELECT * FROM pending_actions WHERE project_id = ? ORDER BY id'),
    session_bindings: q('SELECT * FROM session_bindings WHERE project_id = ? ORDER BY session_key'),
    managed_sessions: q('SELECT * FROM managed_sessions WHERE project_id = ? ORDER BY session_key'),
    sessions_projection: q('SELECT * FROM sessions_projection WHERE project_id = ? ORDER BY session_key'),
  };
}

/** Rows that no project owns: a session in a folder nobody registered. Deleting a project must not touch them. */
function seedUnattributed(db: Db): void {
  const at = '2026-02-01T00:00:00.000Z';
  db.run(
    `INSERT INTO reports (id, session_key, env, session_id, generation, project_id, task_id, task_title, declared_status, source, body, body_sha256, note, captured_at)
     VALUES ('rpt_free', 'posix|free', 'posix', 'free', 1, NULL, 't', 'Free task', 'partial', 'marker', 'b', 'sha', 'n', ?)`,
    [at],
  );
  db.run(
    "INSERT INTO deliveries (id, report_id, project_id, session_key, task_title, state, state_changed_at, created_at, updated_at) VALUES ('dlv_free', 'rpt_free', NULL, 'posix|free', 'x', 'destination_missing', ?, ?, ?)",
    [at, at, at],
  );
  db.run("INSERT INTO delivery_events (id, delivery_id, at, type, actor_json) VALUES ('evt_free', 'dlv_free', ?, 'created', '{}')", [at]);
  db.run("INSERT INTO report_candidates (id, session_key, env, session_id, generation, project_id, reason, body, body_sha256, captured_at) VALUES ('cand_free', 'posix|free', 'posix', 'free', 1, NULL, 'r', 'b', 's', ?)", [at]);
  db.run("INSERT INTO activity (id, at, project_id, source, type, severity, title) VALUES ('act_free', ?, NULL, 'discovery', 'session_discovered', 'info', 'Found a session')", [at]);
  db.run("INSERT INTO notifications (id, activity_id, project_id, at, title, body, native, push, target_json, dedupe_key) VALUES ('ntf_free', 'act_free', NULL, ?, 't', 'b', 'sent', 'sent', '{}', 'dedupe-free')", [at]);
  db.run("INSERT INTO pending_actions (id, kind, status, project_id, session_key, generation, summary, created_at, created_by_json, approvable_by, expires_at) VALUES ('act_p_free', 'permission', 'pending', NULL, 'posix|free', 1, 's', ?, '{}', 'desktop', ?)", [at, at]);
  db.run("INSERT INTO session_bindings (session_key, project_id, conversation_id, source, created_at, updated_at) VALUES ('posix|free', NULL, NULL, 'manual', ?, ?)", [at, at]);
  db.run("INSERT INTO managed_sessions (session_key, env, session_id, project_id, cwd, mode, status, started_at, app_run_id) VALUES ('posix|free', 'posix', 'free', NULL, '/tmp', 'new', 'exited', ?, 'run1')", [at]);
  db.run("INSERT INTO sessions_projection (session_key, env, session_id, project_id, origin, availability, state, view_json, updated_at) VALUES ('posix|free', 'posix', 'free', NULL, 'external', 'live', 'idle', '{}', ?)", [at]);
}

/** Two projects with folders, conversations and workflow rows, plus rows that belong to nobody. */
function setupTwoProjects() {
  env = makeProjectsEnv();
  const { projects, base } = env;
  const a = projects.create({ name: 'Doomed', roots: [{ path: 'C:\\Dev\\Doomed' }, { path: '/home/me/doomed', env: 'wsl:Ubuntu' }] });
  const ca = [projects.conversations.add(a.id, { url: CHAT_A }), projects.conversations.add(a.id, { url: CHAT_B })];
  const b = projects.create({ name: 'Keeper', roots: [{ path: 'C:\\Dev\\Keeper' }] });
  const cb = [projects.conversations.add(b.id, { url: CHAT_A })];
  const seededA = seedWorkflow(base.db, a.id, 'a', ca.map((c) => c.id));
  const seededB = seedWorkflow(base.db, b.id, 'b', cb.map((c) => c.id));
  seedUnattributed(base.db);
  // A delivery attributed to the doomed project although its report is not (the report was captured before the folder
  // was registered). The delivery goes with the project; the report does not.
  base.db.run("INSERT INTO deliveries (id, report_id, project_id, session_key, task_title, state, state_changed_at, created_at, updated_at) VALUES ('dlv_a_late', 'rpt_free', ?, 'posix|free', 'x', 'copied', 't', 't', 't')", [a.id]);
  base.db.run("INSERT INTO delivery_events (id, delivery_id, at, type, actor_json) VALUES ('evt_a_late', 'dlv_a_late', 't', 'created', '{}')");
  base.db.run("INSERT INTO devices (id, name, platform, scopes_json, trusted, token_hash, created_at) VALUES ('dev_1', 'Phone', 'android', '[\"read\"]', 0, 'hash', 't')");
  base.db.run("INSERT INTO raw_events (transport_id, kind, env_id, ingested_at, entry_json) VALUES ('t1', 'hook', 'win', '2026-02-01T00:00:00.000Z', '{}')");
  base.db.run("INSERT INTO hook_installs (env, settings_path, handler_id, plan_hash, installed_at) VALUES ('win', 'p', 'h', 'x', 't')");
  base.db.run("INSERT INTO idempotency (key, principal, route, response_status, response_json, created_at) VALUES ('k', 'p', 'r', 200, '{}', 't')");
  return { projects, base, a, b, ca, cb, seededA, seededB };
}

describe('deleting a project', () => {
  it('has something to delete in every table before it starts (the test is not vacuous)', () => {
    const { base, a, b } = setupTwoProjects();
    for (const owner of [a.id, b.id]) {
      for (const [table, list] of Object.entries(rowsOfProject(base.db, owner))) expect(list.length, `${table} of ${owner}`).toBeGreaterThan(0);
    }
  });

  it('removes everything attached to the project and nothing that belongs to another project or to nobody', () => {
    const { projects, base, a } = setupTwoProjects();
    const before = snapshot(base.db);
    const expected = expectedWithout(before, a.id);

    projects.remove(a.id, 'delete');

    // Table by table, what is left is exactly what belonged to the other project or to nobody. A row that survived
    // with its project id reset to NULL (the foreign keys' ON DELETE SET NULL) would show up here as an extra row.
    const after = snapshot(base.db);
    for (const table of TABLES) expect(after[table], table).toEqual(expected[table]);
    for (const [table, list] of Object.entries(rowsOfProject(base.db, a.id))) expect(list, `${table} of the deleted project`).toEqual([]);
    expect(after.reports.map((r) => r.id).sort()).toEqual(['rpt_b1', 'rpt_b2', 'rpt_free']);
    expect(after.deliveries.map((r) => r.id).sort()).toEqual(['dlv_b1', 'dlv_b2', 'dlv_free']);
    expect(after.report_candidates.map((r) => r.id).sort()).toEqual(['cand_b', 'cand_free']);
    expect(after.session_bindings.map((r) => r.session_key).sort()).toEqual(['posix|free', 'win|b-s1', 'wsl:Ubuntu|b-s2']);
    // the keeper's own rows are intact, including the binding to its conversation
    expect(base.db.get('SELECT conversation_id FROM session_bindings WHERE session_key = ?', ['win|b-s1'])).toMatchObject({ conversation_id: expect.stringMatching(/^cnv_/) });
    expect(projects.get(a.id)).toBeNull();
    expect(projects.list({ includeArchived: true }).map((p) => p.name)).toEqual(['Keeper']);
    expect(projects.conversations.list(a.id)).toEqual([]);
  });

  it('announces a removed session for every projection row, then the removed project, and tells the registry users', () => {
    const { projects, base, a, b, seededA } = setupTwoProjects();
    const mark = base.events.length;
    const before = env.rootsChanged.count;
    projects.remove(a.id, 'delete');
    const events = base.events.slice(mark).map((e) => e.event);
    expect(events.map((e) => e.type)).toEqual(['session.removed', 'session.removed', 'project.removed']);
    expect(events.filter((e) => e.type === 'session.removed').map((e) => (e as { key: string }).key).sort()).toEqual([...seededA.sessionKeys].sort());
    expect(events.at(-1)).toEqual({ type: 'project.removed', id: a.id });
    expect(env.rootsChanged.count).toBe(before + 1);
    expect(projects.registry().resolve('C:\\Dev\\Doomed\\x', 'win').project).toBeNull();
    expect(projects.registry().resolve('C:\\Dev\\Keeper\\x', 'win').project?.id).toBe(b.id);
  });

  it('frees the folders for other projects', () => {
    const { projects, a } = setupTwoProjects();
    projects.remove(a.id, 'delete');
    expect(projects.create({ name: 'Reborn', roots: [{ path: 'C:\\Dev\\Doomed' }] }).roots).toHaveLength(1);
  });

  it('does all of it in one transaction: a failure part way leaves every row, emits nothing and fires nothing', () => {
    const { projects, base, a } = setupTwoProjects();
    base.db.exec("CREATE TRIGGER fail_managed BEFORE DELETE ON managed_sessions BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;");
    const before = snapshot(base.db);
    const mark = base.events.length;
    const fired = env.rootsChanged.count;

    expect(() => projects.remove(a.id, 'delete')).toThrow(/simulated failure/);

    expect(snapshot(base.db)).toEqual(before);
    expect(base.events).toHaveLength(mark);
    expect(env.rootsChanged.count).toBe(fired);
    expect(base.db.inTransaction).toBe(false);
    expect(projects.get(a.id)).not.toBeNull();
    expect(projects.registry().resolve('C:\\Dev\\Doomed', 'win').project?.id).toBe(a.id);

    // and once the obstacle is gone the same call succeeds
    base.db.exec('DROP TRIGGER fail_managed');
    projects.remove(a.id, 'delete');
    expect(snapshot(base.db)).toEqual(expectedWithout(before, a.id));
  });

  it('answers 404 for a project that is already gone, and changes nothing', () => {
    const { projects, base, a } = setupTwoProjects();
    projects.remove(a.id, 'delete');
    const mark = base.events.length;
    expect(failure(() => projects.remove(a.id, 'delete')).status).toBe(404);
    expect(base.events).toHaveLength(mark);
  });

  it('can delete an archived project, and a project that has nothing attached', () => {
    const { projects, a } = setupTwoProjects();
    projects.remove(a.id, 'archive');
    projects.remove(a.id, 'delete');
    expect(projects.get(a.id)).toBeNull();
    const empty = projects.create({ name: 'Empty' });
    projects.remove(empty.id, 'delete');
    expect(projects.get(empty.id)).toBeNull();
  });
});

describe('archiving a project keeps its history', () => {
  it('leaves every row where it was, then restores the project as it was', () => {
    const { projects, base, a } = setupTwoProjects();
    const before = snapshot(base.db);
    projects.remove(a.id, 'archive');
    const after = snapshot(base.db);
    // the project row itself only gains archived_at / updated_at; every other table is exactly as it was
    expect(after.projects.find((p) => p.id === a.id)).toMatchObject({ archived_at: expect.any(String) });
    for (const table of TABLES.filter((t) => t !== 'projects')) expect(after[table], table).toEqual(before[table]);
    expect(projects.list().map((p) => p.name)).toEqual(['Keeper']);
    expect(base.eventsOf('project.removed')).toHaveLength(0);
    expect(base.eventsOf('session.removed')).toHaveLength(0);

    const restored = projects.update(a.id, { archived: false });
    expect(restored.roots).toHaveLength(2);
    expect(projects.conversations.list(a.id)).toHaveLength(2);
    expect(projects.list().map((p) => p.name)).toEqual(['Doomed', 'Keeper']);
  });
});

describe('removing a conversation', () => {
  it('does not rewrite deliveries that were already frozen to it', () => {
    const { projects, base, ca } = setupTwoProjects();
    const before = base.db.all('SELECT id, destination_json FROM deliveries WHERE project_id = ? ORDER BY id', [ca[0].projectId]);
    expect(before.length).toBeGreaterThan(0);
    projects.conversations.remove(ca[0].id);
    expect(base.db.all('SELECT id, destination_json FROM deliveries WHERE project_id = ? ORDER BY id', [ca[0].projectId])).toEqual(before);
  });
});
