import { useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import type { AppHref } from './routes.ts';

export { go } from './routes.ts';
export type { AppHref } from './routes.ts';

export function useNav() {
  const router = useRouter();
  return {
    push: (href: AppHref) => router.push(href as Href),
    replace: (href: AppHref) => router.replace(href as Href),
    back: () => router.back(),
    canGoBack: () => router.canGoBack(),
  };
}
