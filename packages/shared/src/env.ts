// Environments and session identity.
//
// An "environment" is a file-system and process namespace Claude Code runs in. Native Windows and each WSL2
// distribution are separate: they have their own ~/.claude, their own `claude agents` listing and their own paths.
// A session id is only unique inside one environment, so the identity of a session everywhere in Mini-Summa is
// the pair (environment, session id), written `<env>|<uuid>`. This is the same key the verified reducer uses.

export type EnvId = 'win' | 'posix' | `wsl:${string}`;

/** `<env>|<session uuid>`. Never use a bare session id as an identity. */
export type SessionKey = `${EnvId}|${string}`;

const ENV_RE = /^(win|posix|wsl:[A-Za-z0-9._-]+)$/;

export function isEnvId(value: unknown): value is EnvId {
  return typeof value === 'string' && ENV_RE.test(value);
}

export function parseEnvId(value: string): EnvId | null {
  return isEnvId(value) ? value : null;
}

export const isWslEnv = (env: EnvId): env is `wsl:${string}` => env.startsWith('wsl:');

export const wslDistro = (env: EnvId): string | null => (isWslEnv(env) ? env.slice(4) : null);

export function envLabel(env: EnvId): string {
  if (env === 'win') return 'Windows';
  if (env === 'posix') return 'Linux';
  return `WSL (${env.slice(4)})`;
}

export const makeSessionKey = (env: EnvId, sessionId: string): SessionKey => `${env}|${sessionId}`;

export function parseSessionKey(key: string): { env: EnvId; sessionId: string } | null {
  const i = key.indexOf('|');
  if (i < 0) return null;
  const env = key.slice(0, i);
  const sessionId = key.slice(i + 1);
  if (!isEnvId(env) || sessionId === '') return null;
  return { env, sessionId };
}

export const isSessionKey = (value: unknown): value is SessionKey =>
  typeof value === 'string' && parseSessionKey(value) !== null;

/** First 8 characters of the session id: what people see and say aloud. The full key is the identity. */
export function shortSessionId(keyOrId: string): string {
  const parsed = parseSessionKey(keyOrId);
  return (parsed ? parsed.sessionId : keyOrId).slice(0, 8);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
