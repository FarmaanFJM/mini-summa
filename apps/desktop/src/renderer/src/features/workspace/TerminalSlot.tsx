import type { SessionKey } from '@minisumma/shared';
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useTerminals, useUi } from '../../app/runtime';
import { Spinner } from '../../ui';

export interface TerminalSlotProps {
  sessionKey: SessionKey;
  /** Only the active terminal may send input: the selected tab of the visible Claude pane, for a live managed session. */
  active: boolean;
}

/**
 * An empty, measured box. The terminal for this session is created once by the registry and its host element is moved
 * in here; leaving (a tab switch, a layout change) moves it back out without disposing anything.
 */
export function TerminalSlot({ sessionKey, active }: TerminalSlotProps) {
  const registry = useTerminals();
  const slot = useRef<HTMLDivElement>(null);
  const info = useSyncExternalStore(registry.subscribe, () => registry.info(sessionKey), () => null);
  const focusRequest = useUi((s) => s.terminalFocus);

  useLayoutEffect(() => {
    const el = slot.current;
    if (!el) return undefined;
    return registry.mount(sessionKey, el);
  }, [registry, sessionKey]);

  useEffect(() => {
    if (active) registry.setActive(sessionKey);
    return () => { if (registry.active === sessionKey) registry.setActive(null); };
  }, [registry, sessionKey, active]);

  // A tab click, a new session or a resume asks for the cursor to be here.
  useEffect(() => {
    if (active && focusRequest?.key === sessionKey) registry.focus(sessionKey);
  }, [registry, sessionKey, active, focusRequest]);

  const connecting = info?.status === 'connecting' && !info.hasOutput;
  return (
    <div className="ms-term" data-status={info?.status ?? 'connecting'} data-active={active || undefined}>
      <div className="ms-term__slot" ref={slot} onPointerDown={() => { if (active) registry.focus(sessionKey); }} />
      {connecting ? (
        <div className="ms-term__overlay" role="status"><Spinner /><span>Connecting to the terminal.</span></div>
      ) : null}
      {info?.status === 'error' && info.error ? (
        <div className="ms-term__overlay" role="alert"><span>{info.error.message}</span></div>
      ) : null}
    </div>
  );
}
