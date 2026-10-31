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
    // Least privilege. What the built app keeps (read back from the APK with `aapt2 dump permissions`): CAMERA (QR scan), INTERNET,
    // VIBRATE (alert pattern), POST_NOTIFICATIONS, and from Firebase Messaging and AndroidX ACCESS_NETWORK_STATE, WAKE_LOCK,
    // com.google.android.c2dm.permission.RECEIVE and the app's own DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION. Everything else that a
    // library merges into the manifest is blocked here; Expo writes a tools:node="remove" entry per name and the manifest merger applies it.
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.RECORD_AUDIO',
      // Only needed to reschedule notifications after a reboot; the app schedules none.
      'android.permission.RECEIVE_BOOT_COMPLETED',
      // Launcher badge counts, declared by ShortcutBadger (a dependency of expo-notifications). The app never sets a badge count
      // (shouldSetBadge is false and setBadgeCountAsync is not called); the tab badge inside the app is plain UI.
      'com.sec.android.provider.badge.permission.READ',
      'com.sec.android.provider.badge.permission.WRITE',
      'com.htc.launcher.permission.READ_SETTINGS',
      'com.htc.launcher.permission.UPDATE_SHORTCUT',
      'com.sonyericsson.home.permission.BROADCAST_BADGE',
      'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
      'com.anddoes.launcher.permission.UPDATE_COUNT',
      'com.majeur.launcher.permission.UPDATE_BADGE',
      'com.huawei.android.launcher.permission.CHANGE_BADGE',
      'com.huawei.android.launcher.permission.READ_SETTINGS',
      'com.huawei.android.launcher.permission.WRITE_SETTINGS',
      'android.permission.READ_APP_BADGE',
      'com.oppo.launcher.permission.READ_SETTINGS',
      'com.oppo.launcher.permission.WRITE_SETTINGS',
      'me.everything.badger.permission.BADGE_COUNT_READ',
      'me.everything.badger.permission.BADGE_COUNT_WRITE',
      // Declared by androidx.biometric, a dependency of expo-secure-store. The app stores its token with the default options and
      // never asks for a fingerprint or face unlock.
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
      // Declared by the Play install-referrer library (expo-application, a dependency of expo-notifications). The app never reads the install referrer.
      'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',
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
