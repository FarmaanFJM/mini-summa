// Which client this window should use, decided from facts about the page. Pure, so it is tested without a window.
export type DemoScenarioName = 'normal' | 'empty' | 'loading' | 'error' | 'offline';

export type ClientChoice =
  | { kind: 'electron' }
  | { kind: 'demo'; scenario: DemoScenarioName; simulateNative: boolean }
  | { kind: 'remote'; baseUrl: string; token: string }
  | { kind: 'unconfigured'; reason: string };

export interface LocationLike { hash: string; search: string; origin: string }

const SCENARIOS: readonly DemoScenarioName[] = ['normal', 'empty', 'loading', 'error', 'offline'];

/** Pure decision, kept apart from construction so it can be tested without a window. */
export function chooseClient(env: { hasDesktopShell: boolean; location: LocationLike }): ClientChoice {
  if (env.hasDesktopShell) return { kind: 'electron' };
  const query = new URLSearchParams(env.location.search);
  if (query.get('demo') === '1' || query.get('demo') === 'true') {
    const asked = query.get('scenario');
    const scenario = SCENARIOS.find((s) => s === asked) ?? 'normal';
    return { kind: 'demo', scenario, simulateNative: query.get('native') !== 'none' };
  }
  const hash = new URLSearchParams(env.location.hash.replace(/^#/, ''));
  const token = hash.get('token');
  if (token) {
    const base = hash.get('base') ?? env.location.origin;
    if (/^https?:\/\//i.test(base)) return { kind: 'remote', baseUrl: base.replace(/\/+$/, ''), token };
    return { kind: 'unconfigured', reason: 'The address in the URL (base=) is not a web address.' };
  }
  return { kind: 'unconfigured', reason: 'Open Mini-Summa from the desktop app, or add #token=<token> to this address.' };
}
