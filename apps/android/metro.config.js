// Metro resolves the shared SDK straight from its TypeScript source in the monorepo, so the app needs neither a
// `file:` dependency (which would make npm write into packages/shared) nor a published copy.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../../packages/shared');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), sharedRoot];

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolveNext = (ctx) => (upstreamResolveRequest ?? ctx.resolveRequest)(ctx, moduleName, platform);
  if (moduleName === '@minisumma/shared') {
    return { type: 'sourceFile', filePath: path.join(sharedRoot, 'src', 'index.ts') };
  }
  // The shared sources import zod. Resolve it from the app's own node_modules so there is exactly one copy and the
  // build does not depend on what the repository root happens to have installed.
  if (moduleName === 'zod' || moduleName.startsWith('zod/')) {
    return resolveNext({ ...context, originModulePath: path.join(projectRoot, 'package.json') });
  }
  return resolveNext(context);
};

module.exports = config;
