import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db, MIGRATIONS, SCHEMA_VERSION, migrate, newId, openDatabase } from '../src/index.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ms-storage-'));

describe('openDatabase', () => {
  it('creates the schema, uses WAL and enforces foreign keys', () => {
    const dir = tmp();
    const { db, migration } = openDatabase(path.join(dir, 'nested', 'mini-summa.db'));
    expect(migration).toMatchObject({ from: 0, to: SCHEMA_VERSION });
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
    for (const t of ['projects', 'project_roots', 'conversations', 'session_bindings', 'managed_sessions', 'raw_events', 'reports',
      'report_candidates', 'deliveries', 'delivery_events', 'activity', 'notifications', 'pending_actions', 'devices', 'pairing_offers',
      'idempotency', 'hook_installs', 'sessions_projection', 'kv', 'schema_migrations']) expect(tables).toContain(t);
    expect(() => db.run("INSERT INTO conversations (id, project_id, title, url, original_url, kind, created_at, updated_at) VALUES ('c','nope','t','u','u','chat','x','x')")).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('reopens without reapplying migrations and keeps data', () => {
    const file = path.join(tmp(), 'a.db');
    const first = openDatabase(file);
    first.db.run("INSERT INTO kv (key, value_json, updated_at) VALUES ('k','1','t')");
    first.db.close();
    const second = openDatabase(file);
    expect(second.migration.applied).toEqual([]);
    expect(second.db.get<{ value_json: string }>("SELECT value_json FROM kv WHERE key='k'")?.value_json).toBe('1');
    second.db.close();
  });

  it('refuses a database from a newer build', () => {
    const file = path.join(tmp(), 'new.db');
    const { db } = openDatabase(file);
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'future', 't')");
    db.close();
    expect(() => openDatabase(file)).toThrow(/schema version 99/);
  });
});

describe('migrate', () => {
  it('applies only the missing migrations, each atomically', () => {
    const db = new Db(':memory:');
    const base = [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x INTEGER)' }];
    expect(migrate(db, base).applied).toHaveLength(1);
    const more = [...base, { version: 2, name: 'b', sql: 'CREATE TABLE b (y INTEGER)' }, { version: 3, name: 'broken', sql: 'CREATE TABLE c (z INTEGER); THIS IS NOT SQL' }];
    expect(() => migrate(db, more)).toThrow();
    // v2 was applied, v3 rolled back completely (table c must not exist)
    expect(db.get("SELECT name FROM sqlite_master WHERE name='b'")).toBeDefined();
    expect(db.get("SELECT name FROM sqlite_master WHERE name='c'")).toBeUndefined();
    expect(db.get<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations')?.v).toBe(2);
    db.close();
  });

  it('rejects duplicate versions', () => {
    const db = new Db(':memory:');
    expect(() => migrate(db, [{ version: 1, name: 'a', sql: 'SELECT 1' }, { version: 1, name: 'b', sql: 'SELECT 1' }])).toThrow(/Duplicate/);
  });

  it('the shipped migration list is strictly increasing', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([...MIGRATIONS.map((m) => m.version)].sort((a, b) => a - b));
  });
});

describe('Db.tx', () => {
  it('rolls back the whole transaction on error and nests with savepoints', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t (n INTEGER)');
    expect(() => db.tx(() => { db.run('INSERT INTO t VALUES (1)'); throw new Error('boom'); })).toThrow('boom');
    expect(db.all('SELECT * FROM t')).toHaveLength(0);
    db.tx(() => {
      db.run('INSERT INTO t VALUES (1)');
      expect(() => db.tx(() => { db.run('INSERT INTO t VALUES (2)'); throw new Error('inner'); })).toThrow('inner');
      db.run('INSERT INTO t VALUES (3)');
    });
    expect(db.all<{ n: number }>('SELECT n FROM t ORDER BY n').map((r) => r.n)).toEqual([1, 3]);
    expect(db.inTransaction).toBe(false);
  });

  it('supports named and positional parameters', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t (a TEXT, b INTEGER)');
    db.run('INSERT INTO t VALUES (?, ?)', ['x', 1]);
    db.run('INSERT INTO t VALUES (:a, :b)', { a: 'y', b: 2 });
    expect(db.get<{ a: string }>('SELECT a FROM t WHERE b = $b', { b: 2 })?.a).toBe('y');
  });
});

describe('newId', () => {
  it('is prefixed and unique', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('prj')));
    expect(ids.size).toBe(500);
    expect([...ids][0]).toMatch(/^prj_[0-9a-f]{16}$/);
  });
});
