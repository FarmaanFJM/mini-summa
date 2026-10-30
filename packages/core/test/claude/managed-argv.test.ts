import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, redactArgv, scrubEnvironment } from '../../src/claude/managed.ts';

const ID = '0b9a6c5e-87a1-4d5c-9d3e-5d53b6b0a1c2';

describe('buildClaudeArgs', () => {
  it('new session: --session-id <id> --settings <file>', () => {
    expect(buildClaudeArgs({ mode: 'new', sessionId: ID, settingsPath: '/data/s.json', name: null, remoteControl: false }))
      .toEqual(['--session-id', ID, '--settings', '/data/s.json']);
  });

  it('new session with a name and Remote Control: --name <name> --remote-control <name>', () => {
    expect(buildClaudeArgs({ mode: 'new', sessionId: ID, settingsPath: '/data/s.json', name: 'Fix login', remoteControl: true }))
      .toEqual(['--session-id', ID, '--settings', '/data/s.json', '--name', 'Fix login', '--remote-control', 'Fix login']);
  });

  it('new session with Remote Control but no name: a bare --remote-control, last', () => {
    expect(buildClaudeArgs({ mode: 'new', sessionId: ID, settingsPath: '/data/s.json', name: null, remoteControl: true }))
      .toEqual(['--session-id', ID, '--settings', '/data/s.json', '--remote-control']);
  });

  it('resume keeps the SAME id: --resume <id> --settings <file> [--name <name>] [--remote-control]', () => {
    expect(buildClaudeArgs({ mode: 'resume', sessionId: ID, settingsPath: '/data/s.json', name: 'Fix login', remoteControl: true }))
      .toEqual(['--resume', ID, '--settings', '/data/s.json', '--name', 'Fix login', '--remote-control']);
    expect(buildClaudeArgs({ mode: 'resume', sessionId: ID, settingsPath: '/data/s.json', name: null, remoteControl: false }))
      .toEqual(['--resume', ID, '--settings', '/data/s.json']);
  });

  it('never passes a permission mode or anything that would skip the permission dialog', () => {
    const all = buildClaudeArgs({ mode: 'new', sessionId: ID, settingsPath: '/s.json', name: 'n', remoteControl: true }).join(' ');
    expect(all).not.toMatch(/permission|dangerously|bypass/i);
  });
});

describe('scrubEnvironment', () => {
  const source = {
    PATH: '/usr/bin', HOME: '/home/me', TERM: 'dumb', LANG: 'en_US.UTF-8',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '4242', CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'parent-session', CLAUDE_CODE_SESSION_ATTENDED: '1',
    ANTHROPIC_API_KEY: 'sk-test-not-real', ANTHROPIC_AUTH_TOKEN: 'token-not-real', ANTHROPIC_BASE_URL: 'https://proxy.example',
    CLAUDE_CONFIG_DIR: '/home/me/.claude-alt',
    ANTHROPIC_MODEL: 'some-model', ANTHROPIC_SMALL_FAST_MODEL: 'small', ANTHROPIC_LOG: 'debug',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000', ANTHROPIC_VERTEX_PROJECT_ID: 'proj',
  };

  it('removes the variables that identify a parent Claude Code session', () => {
    const env = scrubEnvironment(source);
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED']) {
      expect(env, name).not.toHaveProperty(name);
    }
  });

  it('keeps the credentials and connection settings the user relies on, and CLAUDE_CONFIG_DIR', () => {
    const env = scrubEnvironment(source);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-not-real');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('token-not-real');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/me/.claude-alt');
    expect(env.ANTHROPIC_VERTEX_PROJECT_ID).toBe('proj');
  });

  it('removes other ANTHROPIC_* variables (they are not credentials)', () => {
    const env = scrubEnvironment(source);
    expect(env).not.toHaveProperty('ANTHROPIC_MODEL');
    expect(env).not.toHaveProperty('ANTHROPIC_SMALL_FAST_MODEL');
    expect(env).not.toHaveProperty('ANTHROPIC_LOG');
  });

  it('leaves the rest alone, including the user\'s own CLAUDE_CODE_* options', () => {
    const env = scrubEnvironment(source);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/me');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8000');
  });

  it('sets the terminal capabilities, replacing a poor TERM', () => {
    const env = scrubEnvironment(source);
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
  });

  it('matches names case-insensitively (Windows) and drops undefined values without touching its input', () => {
    const input = { claudecode: '1', Claude_Code_Session_Id: 'x', anthropic_model: 'm', Path: 'C:\\Windows', GONE: undefined };
    const env = scrubEnvironment(input);
    expect(Object.keys(env).sort()).toEqual(['COLORTERM', 'Path', 'TERM']);
    expect(Object.keys(input)).toHaveLength(5);
  });
});

describe('redactArgv', () => {
  it('masks values of options whose name looks like a secret, in both spellings', () => {
    expect(redactArgv(['--api-key', 'sk-123', '--token=abc', '--name', 'ok', '--session-id', ID]))
      .toEqual(['--api-key', '[REDACTED]', '--token=[REDACTED]', '--name', 'ok', '--session-id', ID]);
  });

  it('leaves the arguments Mini-Summa actually passes untouched', () => {
    const argv = ['/usr/bin/claude', '--session-id', ID, '--settings', '/data/managed-settings/posix/x.json', '--name', 'Fix login', '--remote-control'];
    expect(redactArgv(argv)).toEqual(argv);
  });
});
