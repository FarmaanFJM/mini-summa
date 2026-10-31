// Shared test fixtures for the infra services of part 1 (settings, projects, devices, data, tailscale, push).
// Every service is tested against a real in-memory SQLite database, a real event bus and a clock the test moves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerEvent } from '@minisumma/shared';
import { openDatabase } from '@minisumma/storage';
import { expect } from 'vitest';
import type { EnvId } from '@minisumma/shared';
import { createEventBus } from '../../src/bus.ts';
import type { Clock, CoreBase, Logger, ProjectsService, SettingsService } from '../../src/contracts.ts';
import { CoreError } from '../../src/errors.ts';
import { createProjectsService } from '../../src/infra/projects.ts';
import { createSettingsService } from '../../src/infra/settings.ts';

export class TestClock implements Clock {
  private ms: number;
  constructor(iso = '2026-03-01T12:00:00.000Z') { this.ms = Date.parse(iso); }
  now(): Date { return new Date(this.ms); }
  advance(ms: number): void { this.ms += ms; }
  set(iso: string): void { this.ms = Date.parse(iso); }
  iso(): string { return new Date(this.ms).toISOString(); }
}

export interface LogLine { level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: Record<string, unknown> }

export function captureLogger(): Logger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const make = (level: LogLine['level']) => (msg: string, data?: Record<string, unknown>): void => { lines.push({ level, msg, data }); };
  return { lines, debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}

export interface TestBase extends CoreBase {
  clock: TestClock;
  log: ReturnType<typeof captureLogger>;
  /** Every event emitted on the bus, in order. */
  events: { seq: number; event: ServerEvent }[];
  eventsOf<T extends ServerEvent['type']>(type: T): Extract<ServerEvent, { type: T }>[];
  close(): void;
}

export function makeBase(opts: { dataDir?: string; clock?: TestClock; file?: string } = {}): TestBase {
  const { db } = openDatabase(opts.file ?? ':memory:');
  const bus = createEventBus();
  const clock = opts.clock ?? new TestClock();
  const log = captureLogger();
  const events: { seq: number; event: ServerEvent }[] = [];
  bus.subscribe((seq, event) => { events.push({ seq, event }); });
  return {
    db, bus, clock, log, version: '0.0.0-test', mode: 'headless',
    dataDir: opts.dataDir ?? path.join(os.tmpdir(), 'ms-infra-unused'),
    events,
    eventsOf<T extends ServerEvent['type']>(type: T) { return events.map((e) => e.event).filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type); },
    close() { db.close(); },
  };
}

const made: string[] = [];
/** A fresh temporary directory, removed by cleanupTempDirs(). */
export function tempDir(prefix = 'ms-infra-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
export function cleanupTempDirs(): void {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Runs `fn`, expects a CoreError and returns it for further assertions. */
export function failure(fn: () => unknown): CoreError {
  try { fn(); } catch (err) {
    expect(err).toBeInstanceOf(CoreError);
    return err as CoreError;
  }
  throw new Error('Expected the call to throw a CoreError, but it returned normally.');
}

export async function failureAsync(fn: () => Promise<unknown>): Promise<CoreError> {
  try { await fn(); } catch (err) {
    expect(err).toBeInstanceOf(CoreError);
    return err as CoreError;
  }
  throw new Error('Expected the call to reject with a CoreError, but it resolved.');
}

/** User-visible text must not contain dashes used as punctuation (em dash, en dash). */
export function expectPlainText(text: string | null | undefined): void {
  expect(text ?? '').not.toMatch(/[\u2013\u2014]/);
}

/** Polls until `check` returns a truthy value or the time runs out. */
export async function eventually<T>(check: () => T | Promise<T>, timeoutMs = 4000, stepMs = 15): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('eventually: the condition was not met in time');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export interface ProjectsEnv {
  base: TestBase;
  settings: SettingsService;
  projects: ProjectsService;
  /** How many times onRootsChanged fired. */
  rootsChanged: { count: number };
}

/** Settings + projects on a fresh in-memory database. Defaults to a Windows host, the main target of the product. */
export function makeProjectsEnv(opts: { hostPlatform?: 'win32' | 'linux' | 'darwin'; hostEnv?: EnvId } = {}): ProjectsEnv {
  const base = makeBase();
  const settings = createSettingsService({ base });
  const projects = createProjectsService({ base, settings, hostPlatform: opts.hostPlatform ?? 'win32', hostEnv: opts.hostEnv ?? 'win' });
  const rootsChanged = { count: 0 };
  projects.onRootsChanged(() => { rootsChanged.count += 1; });
  return { base, settings, projects, rootsChanged };
}

export const CHAT_A = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
export const CHAT_B = 'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222';
export const CHAT_C = 'https://chatgpt.com/c/33333333-3333-4333-8333-333333333333';
