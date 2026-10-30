// jest-expo reads tsconfig.json `paths` and turns them into moduleNameMapper entries, which is how
// `@minisumma/shared` (TypeScript source in ../../packages/shared) and `zod` resolve under Jest.
module.exports = {
  preset: 'jest-expo/android',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  testMatch: ['<rootDir>/test/**/*.test.ts?(x)'],
  clearMocks: true,
  // The first run after a clean install compiles every module with Babel; leave room for it.
  testTimeout: 30000,
};
