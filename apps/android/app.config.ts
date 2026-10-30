import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExpoConfig } from 'expo/config';

// Push notifications need the user's own Firebase project. The file is never committed (see .gitignore). Without it the
// app still builds and runs; push registration then reports plainly that Firebase is not configured.
const googleServicesFile = process.env.GOOGLE_SERVICES_JSON
  ?? (existsSync(join(__dirname, 'google-services.json')) ? './google-services.json' : undefined);

// A personal sideloaded phone is arm64. Set MINISUMMA_ARCHS=arm64-v8a,armeabi-v7a,x86_64 for a wider (and much slower) build.
const buildArchs = (process.env.MINISUMMA_ARCHS ?? 'arm64-v8a').split(',').map((s) => s.trim()).filter(Boolean);

const config: ExpoConfig = {
  name: 'Mini-Summa',
  slug: 'mini-summa',
  scheme: 'minisumma',
  version: '0.1.0',
  orientation: 'default',
  userInterfaceStyle: 'dark',
  backgroundColor: '#141515',
  icon: './assets/icon.png',
  android: {
    package: 'app.minisumma.companion',
    versionCode: 1,
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#141515' },
    // No Android auto backup: the pairing token must never leave the phone through a cloud backup.
    allowBackup: false,
    // Least privilege. Camera (QR scan), network and notifications are all the app needs.
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.RECORD_AUDIO',
    ],
    ...(googleServicesFile ? { googleServicesFile } : {}),
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-camera', {
      cameraPermission: 'Mini-Summa uses the camera only to scan the pairing code shown on your PC.',
      microphonePermission: false,
      recordAudioAndroid: false,
    }],
    ['expo-notifications', { icon: './assets/notification-icon.png', color: '#10b981', defaultChannel: 'needs-you' }],
    ['expo-build-properties', {
      // R8 shrinking is off: a build that cannot be run on a device here should not also depend on untested keep rules.
      android: { usesCleartextTraffic: false, enableMinifyInReleaseBuilds: false, buildArchs },
    }],
  ],
};

export default config;
