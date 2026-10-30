import type { Core, CoreOptions } from './contracts.ts';

/** Composition root. The architect replaces this stub once the service modules have landed. */
export async function createCore(_options: CoreOptions): Promise<Core> {
  throw new Error('createCore is not wired yet');
}
