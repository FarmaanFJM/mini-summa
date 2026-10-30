// Builds a sideloadable release APK of the Mini-Summa companion.
//
//   node scripts/build-apk.mjs [--clean] [--out <dir>] [--debug]
//
// What it does, in order, and stops with the exact missing piece if one step cannot run:
//   1. checks Java, the Android SDK and the exact SDK packages the generated project needs
//   2. expo prebuild --platform android           (generated android/ is gitignored)
//   3. ./gradlew assembleRelease                  (assembleDebug with --debug)
//   4. re-signs the APK with a LOCAL key and verifies the signature
//
// The signing key is never inside the repository. Without MINISUMMA_KEYSTORE a throwaway key is created under
// ~/.android-build-keys with a random password that exists only in this process (an environment variable for keytool
// and apksigner), is never written to a file, and the key file is deleted after signing. Such an APK is for sideloading
// on your own phone only. To update an installed app later, sign with a key you keep:
//   MINISUMMA_KEYSTORE=/path/to.jks MINISUMMA_KEYSTORE_PASSWORD=... [MINISUMMA_KEY_ALIAS=alias] node scripts/build-apk.mjs
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'android-sdk');
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
const debug = flag('--debug');
const outDir = resolve(option('--out', join(homedir(), 'minisumma-apk')));

function fail(message) { console.error(`\nBuild stopped: ${message}`); process.exit(1); }
function step(title) { console.log(`\n== ${title}`); }
function run(cmd, cmdArgs, opts = {}) {
  console.log(`$ ${[cmd, ...cmdArgs].join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env, cwd: appDir, ...opts });
  if (r.status !== 0) fail(`"${cmd} ${cmdArgs.join(' ')}" exited with ${r.status ?? r.signal}.`);
}

// ---- 1. prerequisites -------------------------------------------------------------------------------------------------
step('Checking prerequisites');
const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
if (java.status !== 0) fail('Java is not installed. Install a JDK 17 or newer (21 works) and put it on PATH.');
if (!existsSync(sdk)) fail(`No Android SDK at ${sdk}. Set ANDROID_HOME, or run scripts/android/setup-sdk.sh from the repository root.`);

const catalog = readFileSync(join(appDir, 'node_modules/react-native/gradle/libs.versions.toml'), 'utf8');
const pick = (key) => new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm').exec(catalog)?.[1];
const need = { compileSdk: pick('compileSdk'), buildTools: pick('buildTools'), ndk: pick('ndkVersion') };
if (!need.compileSdk || !need.buildTools || !need.ndk) fail('Could not read the required SDK versions from react-native/gradle/libs.versions.toml. Run npm install in apps/android first.');
const platformDir = [`android-${need.compileSdk}`, `android-${need.compileSdk}.0`].find((d) => existsSync(join(sdk, 'platforms', d)));
const missing = [];
if (!platformDir) missing.push(`platforms;android-${need.compileSdk}.0`);
if (!existsSync(join(sdk, 'build-tools', need.buildTools))) missing.push(`build-tools;${need.buildTools}`);
if (!existsSync(join(sdk, 'ndk', need.ndk))) missing.push(`ndk;${need.ndk}`);
if (!existsSync(join(sdk, 'cmake', '3.22.1'))) missing.push('cmake;3.22.1');
if (missing.length) {
  fail(`these Android SDK packages are missing: ${missing.join(', ')}.\nInstall them with:\n  ${join(sdk, 'cmdline-tools/latest/bin/sdkmanager')} --sdk_root=${sdk} ${missing.map((m) => `"${m}"`).join(' ')}`);
}
console.log(`Java ok, SDK ${sdk}, compileSdk ${need.compileSdk}, build-tools ${need.buildTools}, NDK ${need.ndk}`);

// ---- 2. generate the native project -----------------------------------------------------------------------------------
step('Generating the Android project (expo prebuild)');
run('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install', ...(flag('--clean') ? ['--clean'] : [])]);
writeFileSync(join(appDir, 'android/local.properties'), `sdk.dir=${sdk}\n`);

// ---- 3. compile ---------------------------------------------------------------------------------------------------------
const task = debug ? 'assembleDebug' : 'assembleRelease';
step(`Gradle ${task}`);
run('./gradlew', [task, '--no-daemon', '--console=plain'], { cwd: join(appDir, 'android') });
const variant = debug ? 'debug' : 'release';
const built = join(appDir, `android/app/build/outputs/apk/${variant}`);
const apkName = readdirSync(built).find((f) => f.endsWith('.apk'));
if (!apkName) fail(`Gradle finished but no APK was found in ${built}.`);
const builtApk = join(built, apkName);

// ---- 4. sign with a local key -------------------------------------------------------------------------------------------
step('Signing with a local key');
const tools = join(sdk, 'build-tools', need.buildTools);
const apksigner = join(tools, 'apksigner');
mkdirSync(outDir, { recursive: true });
const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
const finalApk = join(outDir, `Mini-Summa-${version}-${variant}-sideload.apk`);

let keystore = process.env.MINISUMMA_KEYSTORE;
let alias = process.env.MINISUMMA_KEY_ALIAS ?? 'minisumma';
let throwaway = null;
const signEnv = { ...env };
if (keystore) {
  if (!process.env.MINISUMMA_KEYSTORE_PASSWORD) fail('MINISUMMA_KEYSTORE is set but MINISUMMA_KEYSTORE_PASSWORD is not.');
  signEnv.MINISUMMA_KS_PASS = process.env.MINISUMMA_KEYSTORE_PASSWORD;
} else {
  const keyDir = join(homedir(), '.android-build-keys');
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  keystore = join(keyDir, `throwaway-${Date.now()}.p12`);
  throwaway = keystore;
  alias = 'minisumma-sideload';
  signEnv.MINISUMMA_KS_PASS = randomBytes(24).toString('base64url'); // lives in this process only
  const gen = spawnSync('keytool', [
    '-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', alias, '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '3650', '-dname', 'CN=Mini-Summa sideload (throwaway local key), O=local', '-storepass:env', 'MINISUMMA_KS_PASS',
  ], { stdio: 'inherit', env: signEnv });
  if (gen.status !== 0) fail('keytool could not create the local signing key.');
}
try {
  const sign = spawnSync(apksigner, [
    'sign', '--ks', keystore, '--ks-key-alias', alias, '--ks-pass', 'env:MINISUMMA_KS_PASS', '--key-pass', 'env:MINISUMMA_KS_PASS', '--out', finalApk, builtApk,
  ], { stdio: 'inherit', env: signEnv });
  if (sign.status !== 0) fail('apksigner could not sign the APK.');
  const verify = spawnSync(apksigner, ['verify', '--verbose', '--print-certs', finalApk], { encoding: 'utf8', env: signEnv });
  if (verify.status !== 0) fail(`apksigner verify failed:\n${verify.stdout}${verify.stderr}`);
  console.log(verify.stdout.split('\n').filter((l) => /Verifies|v2|v3|certificate DN|SHA-256/.test(l)).join('\n'));
} finally {
  if (throwaway) rmSync(throwaway, { force: true });
}

const bytes = statSync(finalApk).size;
const sha = createHash('sha256').update(readFileSync(finalApk)).digest('hex');
console.log(`\nAPK: ${finalApk}\nSize: ${(bytes / 1048576).toFixed(1)} MiB (${bytes} bytes)\nSHA-256: ${sha}`);
console.log(throwaway
  ? 'Signed with a throwaway LOCAL key that no longer exists. For sideloading on your own phone only; to update an installed copy, uninstall it first or build with your own keystore (see the header of this script).'
  : 'Signed with the keystore you supplied. For sideloading on your own phone only.');
