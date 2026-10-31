// A controllable stand-in for expo-router. Screens only need the hooks; the navigation stack itself is not under test.
import type { ReactNode } from 'react';

export const router = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
};

let params: Record<string, string> = {};
export const setParams = (p: Record<string, string>): void => { params = p; };

export const useRouter = () => router;
export const useLocalSearchParams = () => params;
export const useRootNavigationState = () => ({ key: 'root' });
export const Redirect = () => null;

function StackImpl({ children }: { children?: ReactNode }) { return <>{children}</>; }
export const Stack = Object.assign(StackImpl, {
  Screen: () => null,
  Protected: ({ children }: { children?: ReactNode }) => <>{children}</>,
});
