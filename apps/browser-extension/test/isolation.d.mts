export const STAND_IN_HOSTS: string[];
export const OTHER_SITE_HOST: string;
export const STAND_IN_NAMES: string[];
export const LOOPBACK_HOSTS: string[];
export function hostResolverRules(standInPort: number): string;
export const CANARY_URL: string;
export const CANARY_EXPECTED: RegExp;
export function isolationFailure(outcome: unknown): Error;
