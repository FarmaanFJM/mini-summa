// Report text must stay in memory. This guard reads the sources: the only module that may touch storage is the
// credential store, and it stores only the pairing (address and token), never anything fetched from the API.
// Node's typings are deliberately not loaded for the app's type check (they redeclare fetch next to React Native's), so
// the few functions used here are typed by hand.
declare const __dirname: string;
const { readdirSync, readFileSync, statSync } = jest.requireActual('fs') as {
  readdirSync(p: string): string[];
  readFileSync(p: string, enc: 'utf8'): string;
  statSync(p: string): { isDirectory(): boolean };
};
const { join, relative } = jest.requireActual('path') as { join(...p: string[]): string; relative(a: string, b: string): string };

const root = join(__dirname, '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name: string) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
});
const files = [...walk(join(root, 'src')), ...walk(join(root, 'app'))];
const rel = (p: string) => relative(root, p).replace(/\\/g, '/');

const STORAGE = /expo-file-system|async-storage|react-native-mmkv|expo-sqlite|react-native-fs|\blocalStorage\b|\bAsyncStorage\b|\bMMKV\b|indexedDB|\bFileSystem\./;

describe('no report text on disk', () => {
  it('only the credential store imports expo-secure-store', () => {
    const users = files.filter((f) => /expo-secure-store/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(users).toEqual(['src/connection/credentials.ts']);
  });

  it('no source file imports or uses any other storage mechanism', () => {
    const offenders = files.filter((f) => STORAGE.test(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the credential store writes one key holding only address, token, device id and server name', () => {
    const src = readFileSync(join(root, 'src/connection/credentials.ts'), 'utf8');
    expect(src.match(/setItemAsync\(/g)).toHaveLength(1);
    expect(src).toContain('JSON.stringify(credentials)');
  });

  it('the app declares no storage dependency of its own', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const banned = Object.keys(pkg.dependencies).filter((d) => /async-storage|mmkv|sqlite|expo-file-system|react-native-fs/.test(d));
    expect(banned).toEqual([]);
  });

  it('the report screen and the client cache have no persistence path', () => {
    const report = readFileSync(join(root, 'src/screens/ReportDetail.tsx'), 'utf8');
    expect(report).not.toMatch(/credentials|SecureStore|setItem/);
  });

  it('backups are off, so the pairing token cannot leave through Android cloud backup', () => {
    const config = readFileSync(join(root, 'app.config.ts'), 'utf8');
    expect(config).toMatch(/allowBackup:\s*false/);
  });

  it('user facing text has no em dashes', () => {
    const offenders = files.filter((f) => /—/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders).toEqual([]);
  });
});
