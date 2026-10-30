import type { ClaudeWebViewState } from '@minisumma/shared';
import { useEffect, useState } from 'react';
import { useNative } from '../../app/native';

/**
 * What the embedded Claude Code on the web page reports: its address, its title and whether it is loading, needs a sign in or
 * failed. null until the host has said, and always null in a host that cannot embed the page (`native.claudeWeb` is absent).
 */
export function useClaudeWebState(enabled: boolean): ClaudeWebViewState | null {
  const native = useNative();
  const host = native.claudeWeb;
  const [state, setState] = useState<ClaudeWebViewState | null>(null);
  useEffect(() => {
    if (!enabled || !host) { setState(null); return undefined; }
    let cancelled = false;
    host.getState().then((s) => { if (!cancelled) setState(s); }, () => {});
    const off = host.onState((s) => { if (!cancelled) setState(s); });
    return () => { cancelled = true; off(); };
  }, [enabled, host]);
  return state;
}
