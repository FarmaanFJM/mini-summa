// One owner of the layout preferences for the whole window, so the sidebar and the workspace never disagree.
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useLayoutPrefs } from '../workspace/layoutPrefs';
import type { LayoutController } from '../workspace/layoutPrefs';

const LayoutContext = createContext<LayoutController | null>(null);

export function LayoutProvider({ children }: { children?: ReactNode }) {
  const controller = useLayoutPrefs();
  return <LayoutContext.Provider value={controller}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutController {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used inside <LayoutProvider>.');
  return ctx;
}
