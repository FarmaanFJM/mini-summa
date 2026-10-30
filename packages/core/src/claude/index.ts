// The Claude Code layer of the core: environments, the raw log, the reducer host, sessions, discovery and ingestion
// (the observer half), plus the managed-terminal half re-exported for the composition root.
export { createEnvironmentsService } from './environments.ts';
export type { EnvironmentsDeps, HostProbe } from './environments.ts';
export { defaultCommandRunner, decodeCommandOutput, parseWslDistroList } from './commandRunner.ts';
export type { CommandOptions, CommandResult, CommandRunner } from './commandRunner.ts';
export { windowsPathToWsl, wslPathToWindows, envTag } from './envPaths.ts';
export { createRawStore } from './rawStore.ts';
export type { RawStore } from './rawStore.ts';
export { createProjection, attribute, excerptOf } from './projection.ts';
export type { ApplyResult, Attribution, AttributionContext, Projection, ProjectionDeps, SessionFacts } from './projection.ts';
export { buildSessionView } from './sessionView.ts';
export type { SessionViewInput } from './sessionView.ts';
export { createSessionsService } from './sessions.ts';
export type { ObserverSessionsService, ProjectsPort, SessionsDeps } from './sessions.ts';
export { createRegistryFileWriter, writeFileAtomic } from './registryFile.ts';
export { createManagedManager } from './managed.ts';
export type { ManagedManagerExtras } from './managed.ts';
