// Guards for things that only fail on a device or in the build: the routes folder, the tab files and the Expo config.
declare const __dirname: string;
const { existsSync, readdirSync, readFileSync } = jest.requireActual('fs') as {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  readFileSync(p: string, enc: 'utf8'): string;
};
const { join } = jest.requireActual('path') as { join(...p: string[]): string };

const root = join(__dirname, '..');

describe('routes', () => {
  it('has no src/app folder: Expo Router would use it as the routes root instead of ./app', () => {
    expect(existsSync(join(root, 'src/app'))).toBe(false);
  });

  it('has a route file for every screen the root layout names, and every tab', () => {
    const layout = readFileSync(join(root, 'app/_layout.tsx'), 'utf8');
    const names = [...layout.matchAll(/<Stack\.Screen name="([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(5);
    const missing = names.filter((name) => {
      const file = name === '(tabs)' ? 'app/(tabs)/_layout.tsx' : `app/${name}.tsx`;
      return !(existsSync(join(root, file)) || existsSync(join(root, `app/${name.replace(/\/index$/, '')}/index.tsx`)));
    });
    expect(missing).toEqual([]);
    const { TABS } = require('../src/tabs') as { TABS: { name: string }[] };
    expect(new Set(TABS.map((t) => t.name)).size).toBe(TABS.length);
    expect(TABS.filter((t) => !existsSync(join(root, `app/(tabs)/${t.name}.tsx`)))).toEqual([]);
    const files = readdirSync(join(root, 'app/(tabs)')).filter((f) => f !== '_layout.tsx');
    expect(files.length).toBe(TABS.length);
  });

  it('every route file has a default export', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (n.endsWith('.tsx') ? [join(dir, n)] : n.includes('.') ? [] : walk(join(dir, n))));
    const without = walk(join(root, 'app')).filter((f) => !/export default|as default/.test(readFileSync(f, 'utf8')));
    expect(without).toEqual([]);
  });
});

describe('Expo config', () => {
  const config = (require('../app.config') as { default: Record<string, any> }).default;

  it('identifies the app and opens minisumma:// links', () => {
    expect(config.name).toBe('Mini-Summa');
    expect(config.scheme).toBe('minisumma');
    expect(config.android.package).toBe('app.minisumma.companion');
  });

  it('asks for as little as it can', () => {
    expect(config.android.allowBackup).toBe(false);
    expect(config.android.blockedPermissions).toEqual(expect.arrayContaining([
      'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.RECORD_AUDIO',
    ]));
    const camera = config.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-camera');
    expect(camera[1]).toMatchObject({ microphonePermission: false, recordAudioAndroid: false });
  });

  it('refuses cleartext http and files FCM pushes under the needs-you channel', () => {
    const build = config.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-build-properties');
    expect(build[1].android.usesCleartextTraffic).toBe(false);
    const notifications = config.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-notifications');
    expect(notifications[1].defaultChannel).toBe('needs-you');
  });

  it('never references a Firebase file that is not there: no google-services.json is committed', () => {
    expect(existsSync(join(root, 'google-services.json'))).toBe(false);
    expect(config.android.googleServicesFile).toBeUndefined();
  });
});
