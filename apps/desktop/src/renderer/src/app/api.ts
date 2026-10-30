import type { MiniSummaClient } from '@minisumma/shared';

/**
 * Everything the UI needs from the core, and nothing more. The real MiniSummaClient satisfies it, so do the demo client
 * and the test doubles; features depend on this type, never on the concrete class.
 */
export type ApiClient = Pick<MiniSummaClient, 'call' | 'events' | 'terminal'>;
