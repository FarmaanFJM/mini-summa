// Builds a sideloadable release APK of the Mini-Summa companion.
//
//   node scripts/build-apk.mjs [--clean] [--out <dir>] [--debug]
//                              [--retries <n>] [--wait <seconds>]
//                              [--net-attempts <n>] [--net-backoff <ms>] [--gradle-arg <arg>]...
//
// What it does, in order, and stops with the exact missing piece if one step cannot run:
//   1. checks Java, the Android SDK and the exact SDK packages the generated project needs
//   2. expo prebuild --platform android           (generated android/ is gitignored)
//   3. ./gradlew assembleRelease                  (assembleDebug with --debug)
//   4. re-signs the APK with a LOCAL key and verifies the signature
//
// Downloads (step 3). Gradle fetches several hundred files from Maven Central, Google Maven, the Gradle Plugin Portal and
// JitPack. Some networks (shared or cloud addresses) are throttled: the server answers a share of the requests with
// "429 Too Many Requests". Gradle keeps every file it already downloaded, so a second run continues where the first stopped.
// This script helps in two ways, and never changes what is downloaded, from where, or how it is checked:
//   * it makes Gradle patient: --net-attempts (default 10) tries per file and --net-backoff (default 1500 ms, doubling after each
//     failed try). These are Gradle's own settings (org.gradle.internal.network.retry.* for libraries and
//     org.gradle.internal.repository.* for POM/module files); a value you already set in ~/.gradle/gradle.properties wins;
//   * it runs Gradle again after a pause when the failure was only a refused or dropped download: --retries (default 2, 0 = off)
//     re-runs, first pause --wait seconds (default 60), doubling up to 10 minutes.
// When Gradle still fails because of the network, the script says which servers refused it, with which HTTP status and which
// files, instead of leaving you with a wall of Gradle output. --gradle-arg passes one extra argument to Gradle
// (for example --gradle-arg --info, repeat it for more).
//
// The signing key is never inside the repository. Without MINISUMMA_KEYSTORE a throwaway key is created under
// ~/.android-build-keys with a random password that exists only in this process (an environment variable for keytool
// and apksigner), is never written to a file, and the key file is deleted after signing. Such an APK is for sideloading
// on your own phone only. To update an installed app later, sign with a key you keep:
//   MINISUMMA_KEYSTORE=/path/to.jks MINISUMMA_KEYSTORE_PASSWORD=... [MINISUMMA_KEY_ALIAS=alias] node scripts/build-apk.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { explainDownloadFailure, isTransient, newEvidence, scanLine } from './gradle-network.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) { console.error(`\nBuild stopped: ${message}`); process.exit(1); }
function step(title) { console.log(`\n== ${title}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- options ----------------------------------------------------------------------------------------------------------
const USAGE = `Usage: node scripts/build-apk.mjs [--clean] [--out <dir>] [--debug] [--retries <n>] [--wait <seconds>]
                                   [--net-attempts <n>] [--net-backoff <ms>] [--gradle-arg <arg>]...
  --clean           regenerate android/ from scratch (expo prebuild --clean)
  --out <dir>       where the signed APK is written (default ~/minisumma-apk)
  --debug           build the debug variant instead of release
  --retries <n>     run Gradle again up to n more times when it only failed because a download was refused or dropped (default 2, 0 = never)
  --wait <seconds>  pause before the first re-run (default 60); it doubles every time, up to 600
  --net-attempts <n>  how many times Gradle tries each file before giving up (default 10; Gradle's own default is 3)
  --net-backoff <ms>  Gradle's first wait between tries, doubled after each failed try (default 1500)
  --gradle-arg <a>  one extra argument for ./gradlew, repeatable (for example --gradle-arg --info)`;
const argv = process.argv.slice(2);
const switches = new Set();
const values = new Map();
const extraGradleArgs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  else if (['--clean', '--debug'].includes(a)) switches.add(a);
  else if (['--out', '--retries', '--wait', '--net-attempts', '--net-backoff', '--gradle-arg'].includes(a)) {
    const v = argv[++i];
    if (v === undefined) fail(`${a} needs a value.\n\n${USAGE}`);
    if (a === '--gradle-arg') extraGradleArgs.push(v); else values.set(a, v);
  } else fail(`unknown option "${a}".\n\n${USAGE}`);
}
const flag = (name) => switches.has(name);
const option = (name, fallback) => values.get(name) ?? fallback;
function count(name, fallback, min) {
  const raw = option(name, undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) fail(`${name} must be a whole number of at least ${min} (got "${raw}").`);
  return n;
}

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'android-sdk');
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
const debug = flag('--debug');
const outDir = resolve(option('--out', join(homedir(), 'minisumma-apk')));
const retries = count('--retries', 2, 0);
const waitSeconds = count('--wait', 60, 1);
const netAttempts = count('--net-attempts', 10, 1);
const netBackoff = count('--net-backoff', 1500, 1);

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
// Runs Gradle, streams its output to the terminal unchanged, and remembers what a refused or dropped download looked like.
function gradleOnce(gradleArgs) {
  return new Promise((done) => {
    const evidence = newEvidence();
    const child = spawn('./gradlew', gradleArgs, { cwd: join(appDir, 'android'), env, stdio: ['inherit', 'pipe', 'pipe'] });
    const forward = (sink) => {
      let rest = '';
      return (chunk) => {
        sink.write(chunk);
        rest += chunk.toString('utf8');
        const lines = rest.split('\n');
        rest = lines.pop() ?? '';
        for (const l of lines) scanLine(l, evidence);
      };
    };
    child.stdout.on('data', forward(process.stdout));
    child.stderr.on('data', forward(process.stderr));
    child.on('error', (error) => done({ code: null, signal: null, error, evidence }));
    child.on('close', (code, signal) => done({ code, signal, evidence }));
  });
}

const task = debug ? 'assembleDebug' : 'assembleRelease';
// Gradle's own retry settings. Skip any the user already set (their value would win on the command line otherwise).
const userGradleHome = process.env.GRADLE_USER_HOME ?? join(homedir(), '.gradle');
let userProps = '';
try { userProps = readFileSync(join(userGradleHome, 'gradle.properties'), 'utf8'); } catch { /* none */ }
const retryProps = {
  'org.gradle.internal.network.retry.max.attempts': netAttempts,
  'org.gradle.internal.network.retry.initial.backOff': netBackoff,
  'org.gradle.internal.repository.max.tentatives': netAttempts,
  'org.gradle.internal.repository.initial.backoff': netBackoff,
};
const userSet = (name) => userProps.includes(`systemProp.${name}`) || (process.env.GRADLE_OPTS ?? '').includes(`-D${name}`) || extraGradleArgs.some((a) => a.startsWith(`-D${name}`));
const retryArgs = Object.entries(retryProps).filter(([name]) => !userSet(name)).map(([name, v]) => `-D${name}=${v}`);
const gradleArgs = [task, '--no-daemon', '--console=plain', ...retryArgs, ...extraGradleArgs];

const attemptsTotal = retries + 1;
let result;
for (let attempt = 1; attempt <= attemptsTotal; attempt++) {
  if (attempt > 1) {
    const pause = Math.min(waitSeconds * 2 ** (attempt - 2), 600);
    console.log(`\nWaiting ${pause} s before Gradle run ${attempt} of ${attemptsTotal}. Gradle keeps what it already downloaded, so this run continues where the last one stopped.`);
    await sleep(pause * 1000);
  }
  step(`Gradle ${task}${attemptsTotal > 1 ? ` (run ${attempt} of ${attemptsTotal})` : ''}`);
  console.log(`$ ./gradlew ${gradleArgs.join(' ')}`);
  result = await gradleOnce(gradleArgs);
  if (result.error) fail(`could not start ./gradlew in ${join(appDir, 'android')}: ${result.error.message}`);
  if (result.code === 0) break;
  if (result.signal) fail(`Gradle was stopped by ${result.signal}.`);
  if (!isTransient(result.evidence)) break;
  console.error(explainDownloadFailure(result.evidence));
}
if (result.code !== 0) {
  if (isTransient(result.evidence)) {
    fail(`Gradle still could not download everything after ${attemptsTotal} run(s) (exit code ${result.code}). See the list of refused files above.\nRun the same command again later (--retries ${retries + 3} --wait 120 waits longer), or from another network.`);
  }
  fail(`Gradle exited with ${result.code}, and the output shows no refused or dropped download, so this looks like a build problem and not a network one. Read the "What went wrong" part above (add --gradle-arg --stacktrace for more).`);
}
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
