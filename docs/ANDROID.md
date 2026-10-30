# Mini-Summa for Android

The Android app is a companion to Mini-Summa on your PC. It shows what Claude Code is doing, brings reports to your
phone, tells you when something needs you, and lets you answer a permission request or send a prompt to a Mini-Summa
terminal. It does not run Claude, it does not talk to ChatGPT, and it never types into a session unless you confirm it.

This document says how to build it, install it, pair it and what it can and cannot do today. The last section lists
what was verified and what was **not tested**.

## What you need

On the PC:

* Mini-Summa running, with phone access on and `tailscale serve` publishing it. The phone talks to the `https://<pc>.<tailnet>.ts.net`
  address that Tailscale Serve gives. Funnel (public internet) is never used.
* Tailscale signed in and connected.

On the phone:

* Android 7.0 or newer, 64-bit ARM (arm64). Nearly every phone since 2017 is. See "Build notes" below for x86 or 32-bit.
* The Tailscale app, signed in to the **same tailnet** as the PC, with the VPN switched on while you use Mini-Summa.

In your tailnet (admin console, DNS page): MagicDNS on and **HTTPS Certificates** enabled. Without them `tailscale serve`
cannot give the PC an `https` address, and the release app refuses plain `http` addresses to other devices.

## Tailscale on the phone

1. Install Tailscale from Google Play and sign in with the same account (or a shared node) as your PC.
2. Turn the VPN on. The phone and the PC should both show as connected.
3. Open `https://<your-pc>.<tailnet>.ts.net/api/v1/health` in the phone's browser. You should see a short JSON answer that
   mentions `mini-summa-core`. If you do not, the app cannot connect either: check that the PC is awake and that Tailscale
   Serve is on in Mini-Summa.

When the PC is asleep, off, or this phone is not on the tailnet, the app says so, shows when it last heard from the PC, and
marks everything as not live. It never shows old data as current.

## Build the APK

You need Node 22, a JDK (17 or newer; 21 is what was used), and the Android SDK with these exact packages. They are what
Expo SDK 58 / React Native 0.88 ask for (they are read from `node_modules/react-native/gradle/libs.versions.toml`):

| Package | Version |
| --- | --- |
| Platform | `platforms;android-37.0` (compileSdk 37) |
| Build tools | `build-tools;37.0.0` |
| NDK | `ndk;27.1.12297006` |
| CMake | `cmake;3.22.1` |

```bash
export ANDROID_HOME=$HOME/android-sdk ANDROID_SDK_ROOT=$HOME/android-sdk
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --sdk_root=$ANDROID_HOME \
  "platforms;android-37.0" "build-tools;37.0.0" "ndk;27.1.12297006" "cmake;3.22.1"
```

Note: `scripts/android/setup-sdk.sh --full` currently defaults to platform 36 and build-tools 36.0.0, which is **not** what
this project needs. Pass `ANDROID_PLATFORM=android-37.0 ANDROID_BUILD_TOOLS=37.0.0`, or use the command above.

Then, from the repository:

```bash
cd apps/android
npm install            # this folder is deliberately not part of the root npm workspaces
npm run build:apk      # = node scripts/build-apk.mjs
```

`build:apk` checks the prerequisites and names whatever is missing, runs `expo prebuild --platform android`, runs
`./gradlew assembleRelease`, signs the result with a local key and prints the path, size and SHA-256. The generated
`android/` folder and every `*.apk` and keystore are gitignored. The APK is written outside the repository, to
`~/minisumma-apk/` (change it with `--out <dir>`). Add `--debug` for a debug build and `--clean` to regenerate `android/`.
If Gradle fails because a download was refused or dropped (HTTP 429 and 5xx, timeouts), the script lists which servers refused
which files, waits, and runs Gradle again (`--retries`, default 2, and `--wait`, default 60 s and doubling); see "Build notes".
`--help` lists every option.

The same by hand:

```bash
npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleRelease
```

### Signing

A release APK must be signed before Android installs it. Unless you provide a key, the script creates a **throwaway local
key** under `~/.android-build-keys/` with a random password that only exists in the script's memory, signs, verifies, and
deletes the key. That APK is for sideloading on your own phone only. Because the key is gone, a later build has a different
signature: uninstall the old app first (you will pair again). The script's signing and `apksigner verify` steps have run once, on
the APK described under "Build outcome" below. To keep one identity so updates install over the old app:

```bash
MINISUMMA_KEYSTORE=/path/to/your.jks MINISUMMA_KEYSTORE_PASSWORD=... MINISUMMA_KEY_ALIAS=yourAlias npm run build:apk
```

Keep that keystore out of the repository. Do not add a `google-services.json` unless it is your own (see Push below).

### Build notes

* **CPU:** the default is `arm64-v8a` only, which keeps the native build short. For other CPUs set
  `MINISUMMA_ARCHS=arm64-v8a,armeabi-v7a,x86_64` (a much longer build).
* **Gradle** is downloaded by the wrapper (9.4.1), and Android Gradle Plugin 9.2.1 and the React Native artifacts come from
  Google Maven, Maven Central, the Gradle Plugin Portal and JitPack. A first build downloads a lot: Gradle's cache was already
  406 MB after the configuration step, before anything was compiled.
* **HTTP 429 from Maven Central.** Maven Central limits downloads per network address. The refusal is a `429` whose body reads
  "Your ip has exceeded rate limits" and points to https://central.sonatype.org/faq/429-error/ (there is no `Retry-After`
  header). On a shared address (hosted CI, cloud sandboxes, some company networks) other people's traffic counts too, so a small
  build can be refused. Sonatype says the blocks are temporary (short at first, lifted automatically), that retrying harder
  usually makes it worse, and that the lasting fix is a cache or a repository manager. Nothing is wrong with the app. Gradle
  reports it as "Could not GET ... Received status code 429" or, for a POM file, "Repository MavenRepo is disabled due to earlier
  error" (add `--gradle-arg --info` to see every attempt). What helps, in this order:
  1. **Patience, spaced out.** Gradle 9.4.1 does retry a 429, but by default only 3 tries 1 s and 2 s apart, and a failed POM
     lookup switches the whole repository off for the rest of the build. `npm run build:apk` therefore passes Gradle's own retry
     settings (10 tries per file, the wait starting at 1.5 s and doubling after each try, so the last try comes about 13 minutes
     after the first) unless you set them yourself, and it runs Gradle again after a pause when a download was refused:
     `--retries` (default 2) and `--wait` (default 60 s, doubling). Gradle keeps every file it downloaded, so each run continues
     where the last one stopped. To set the same for every Gradle build, put this in `~/.gradle/gradle.properties` (outside the
     repository):
     ```
     systemProp.org.gradle.internal.network.retry.max.attempts=10
     systemProp.org.gradle.internal.network.retry.initial.backOff=1500
     systemProp.org.gradle.internal.repository.max.tentatives=10
     systemProp.org.gradle.internal.repository.initial.backoff=1500
     ```
     The first pair governs library downloads (`.jar`, `.aar`), the second pair POM and module files. These are the names
     Gradle 9.4.1 reads (taken from its classes); `...repository.max.retries`, which older notes and a previous version of this
     file used, is not read at all, and `max.tentatives` alone does not cover library downloads.
  2. **A local, checksum-verified repository in front of the normal ones.** `scripts/android/prefetch-maven.mjs` downloads exactly the
     files Gradle could not get (plain `curl`, default User-Agent, one request at a time, waiting after each 429), compares each
     with the SHA-1 (and SHA-256 when published) that the registry publishes next to it, optionally checks the `.asc` signature
     (`--signatures`), and only then installs it into `~/ms-maven`. It refuses a file that has no published checksum. Copy
     `scripts/android/local-maven.init.gradle` to `~/.gradle/init.d/`: it adds that folder as a repository **in front of** the
     plugin, buildscript and project repositories and removes or disables nothing, so every other file still comes from the normal
     repositories with the checks they have. Gradle normally fetches a module's files from the repository that supplied its metadata, which is why
     the tool installs the `.pom` (and `.module`) next to each file. Usage: `node scripts/android/prefetch-maven.mjs --signatures --log
     <gradle output> [<url>...]`; `--gav group:artifact:version` names a module directly. To list what is still missing without
     touching the network, run `./gradlew assembleRelease --offline --continue` in `apps/android/android`, save its output and pass
     it to `--log`; Gradle then downloads the rest itself. The signature check needs `gpg`; a public key that keys.openpgp.org lists
     without a verified user ID cannot be imported, and the tool then says "not verifiable here" for that file.
  3. **Another network, or a repository manager you trust** (a home or office connection, or Nexus/Artifactory/another caching proxy
     configured as a Gradle init script in `~/.gradle/init.d/`). This repository does not configure one for you.
* R8 shrinking is switched off (`expo-build-properties`), so an APK that could not be run on a device while it was built does
  not also depend on untested keep rules. Turn it on in `app.config.ts` if you want a smaller APK.

## Install (sideload)

1. Copy the APK to the phone (USB, a cloud drive, or `adb install -r Mini-Summa-0.1.0-release-sideload.apk`).
2. If you open it from a file manager or a browser, Android asks to allow "Install unknown apps" for that app. Allow it for
   the install only.
3. Play Protect may warn that the app is from an unknown developer. That is expected for a self-signed APK.
4. Check the SHA-256 the build printed against `sha256sum` of the file you installed.

These steps describe what Android normally does with a sideloaded APK. They have **not** been tried with the APK built in the sandbox (see
"Build outcome").

## Pair

1. In Mini-Summa on the PC, create a pairing code for a phone. It shows a QR code and is valid once, for a short time.
2. Open the app. Allow the camera (only used to read this QR code) and scan it.
3. Check the desktop name and address the app shows, then press **Pair with ...**. The app tries each address in the code
   in order (`GET /api/v1/health`, 4 second limit), then redeems the one-time code.

By hand: choose **Enter the code by hand** and fill in the address of your PC, the **offer ID** and the **pairing code**. You can
also paste the whole `minisumma://pair?...` link into any of the three fields, and a `minisumma://pair?...` link opened from
another app fills the screen too. The app stores only the address, the device token, the device id and the desktop's name, in
Android's encrypted storage. Nothing else is written to disk.

To remove a phone, press **Unpair this phone** in Settings (this wipes the token from the phone) and remove it in Mini-Summa on
the PC. If you remove the phone on the PC first, the app notices (HTTP 401, the live connection closing with code 4003, or the token being refused at connect with code 4401),
wipes its token and shows "This phone was removed in Mini-Summa. Pair again."

## What the app does

* **Home:** a "Needs you" list (permission requests and prompts waiting for approval, sessions waiting for input or reporting an
  error, reports nobody opened), then your projects with their live session count.
* **Project and session screens** always say which project and which session you are looking at (project name, short session id,
  environment, whether Mini-Summa started it, whether it is live, its state). A session that merely stopped being listed is worded
  "may have ended"; only an observed end is "ended".
* **Reports:** the full text, selectable, with code blocks in monospace. Copy and Share send the whole text. Status is always
  "declared by Claude, not verified". "Open linked ChatGPT conversation" opens the destination that was frozen when the report
  arrived, or the project's preferred conversation, in the browser or the ChatGPT app. Mini-Summa sends nothing to ChatGPT; you paste.
  Report text is kept in memory only.
* **Activity:** filters (needs action, unread, project) are in a sheet; pull to refresh; tapping an entry marks it read and opens it.
* **Inbox:** pending actions with the exact tool and redacted excerpt, or the full prompt text. Approve and Reject need the
  `approve` permission; without it the buttons are not offered and the card says why. A prompt you sent from this phone cannot be
  approved from this phone (unless the PC says any approver may).
* **Send to Claude:** only for a session that Mini-Summa started and that is live, and only if this phone may send prompts. You see
  the target (project, session, kind, state, generation), then a confirmation ("Send this text to GitManager, session a1b2c3d4?"),
  then the true outcome: "Waiting for approval on your PC", "Sent", or "Could not send: reason". One idempotency key is used per
  attempt, so retrying after a lost answer cannot send twice. A failed send is never retried automatically.
* **Remote Control:** external and background sessions are observed only. The app explains `/remote-control` and
  `claude --remote-control` and opens https://claude.ai/code.

## Push notifications

Without push, the app shows everything live while it is open and connected. Push is what wakes the phone when the app is closed.
It needs **your own Firebase project**: Mini-Summa has no server.

1. In the Firebase console create a project and add an **Android app** with the package name `app.minisumma.companion`.
2. Download its `google-services.json` and put it at `apps/android/google-services.json` (gitignored), or point
   `GOOGLE_SERVICES_JSON=/path/to/file` at it. Build the APK again (`npm run build:apk`).
3. In the same project open Project settings, Service accounts, and generate a private key (a JSON file). Import that JSON in
   Mini-Summa on the PC (the `push.configure` route). The PC then sends pushes straight to FCM.
4. Open the app. When it connects it asks for the notification permission, reads its FCM token and registers it
   (`devices.registerPush`). Settings shows the result.

If the app was built without `google-services.json`, Settings says: "Push notifications need your own Firebase project. See
docs/ANDROID.md". Nothing crashes and live in-app updates keep working.

**What a push contains:** ids only (`kind`, `projectId`, `sessionKey`, `reportId`, `activityId`) plus the title and sentence the PC
wrote. The app ignores every other field and never expects report text. A tap opens the report, session, project, the inbox (for a
permission request) or the activity feed, and the screen then loads its content from the PC.

**Channels** (created when the app starts): `needs-you` (high importance) and `updates` (default importance). The PC's FCM
messages carry no channel id, so Android files them under the app's default FCM channel, which this app sets to `needs-you`:
everything the PC pushes (a report, a permission request, a question, an error, a lost session, a prompt waiting for approval)
is something that waits for you. A sender that wants a quieter push can set `android.notification.channel_id` to `updates`.
The local "Send a test notification" in Settings uses `updates`.

If the PC is asleep, off or not on the tailnet, nothing can be pushed (the PC is the sender).

## Privacy and permissions

**Permissions.** The app asks Android at run time for two things only: the **camera** (to read the pairing QR code) and
**notifications**. The built APK declares 27 permissions in its merged manifest (`aapt2 dump badging`); the other 25 need no
prompt. The app itself asks for `INTERNET` and `VIBRATE` (the alert pattern). The remaining 23 are not features of this app: the
manifest merger report names the libraries that add them. `ACCESS_NETWORK_STATE` (androidx.media3), `USE_BIOMETRIC` and
`USE_FINGERPRINT` (androidx.biometric; the app never asks for a fingerprint), `WAKE_LOCK` and
`com.google.android.c2dm.permission.RECEIVE` (Firebase Messaging, the push receiver), `BIND_GET_INSTALL_REFERRER_SERVICE` (the Play
install-referrer library), `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` (AndroidX, named after the app's own package), and 16
launcher badge-count permissions (Samsung, HTC, Sony, Huawei, OPPO and other launchers) from ShortcutBadger 1.1.22. They can be
removed by listing them in `android.blockedPermissions` in `app.config.ts`; that has **not** been done or tested. Storage,
overlay, microphone and start-at-boot permissions are blocked, and none of `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`,
`SYSTEM_ALERT_WINDOW`, `RECORD_AUDIO` or `RECEIVE_BOOT_COMPLETED` is in the APK (checked with `aapt2 dump permissions`).

Android cloud backup is off (`allowBackup=false`, read back from the built APK) so the token cannot leave the phone that way,
and cleartext HTTP is off (`usesCleartextTraffic=false`). The phone never caches report bodies, and no source file imports a
storage library other than the secure credential store (a test enforces that). Two things leave the app on your request: **Copy**
puts the report on the Android clipboard (other apps may be able to read the clipboard, so copy something else afterwards if the
report is sensitive) and **Share** hands the text to the app you pick.

## Verified and NOT TESTED

Verified here (Linux, Node 22.22; commands run from `apps/android` unless noted):

| What | Result |
| --- | --- |
| `npx tsc --noEmit` (app, tests and the shared SDK source) and `npx tsc --noEmit -p tsconfig.config.json` | clean |
| `npx jest` (jest-expo, React Native Testing Library, a fake desktop that speaks the real route table) | 15 suites, 216 tests pass |
| `npm run check:core` (from the repo root install: the app's own pairing, connection and send code against the **real** headless core in `packages/core`) | 10 of 10 checks pass |
| `npx expo-doctor` | 20 of 20 checks pass |
| `npx expo install --check` | dependencies match Expo SDK 58 |
| `npx expo export --platform android` (Metro with the shared source and zod, Hermes bytecode) | bundles 1,408 modules into a 3.5 MB `.hbc` |
| `npx expo prebuild --platform android` | generates the project; the app's own manifest declares CAMERA, INTERNET and VIBRATE (POST_NOTIFICATIONS comes from the notifications library), removes storage, overlay, audio and boot permissions, `allowBackup=false`, `usesCleartextTraffic=false`, the `minisumma` link scheme and FCM default channel `needs-you`. Permissions that libraries add are merged later by Gradle: see the APK rows below |
| Android SDK packages from the table above installed with `sdkmanager` | done |
| Gradle wrapper (9.4.1) downloads and starts | done |
| `node scripts/build-apk.mjs --gradle-arg --info --retries 3 --wait 30` (the real script, JDK 21, the SDK packages above) | Gradle `BUILD SUCCESSFUL in 8m 35s` (565 tasks), then the script's own signing and `apksigner verify`; it printed the APK path, size and SHA-256 given below |
| `apksigner verify --verbose --print-certs` on the APK (by the script, and again by hand) | `Verifies`; APK Signature Scheme v2 and v3 true; one signer, the throwaway local key (RSA 2048) |
| `aapt2 dump badging` and `aapt2 dump permissions` on the APK | package `app.minisumma.companion`, versionName 0.1.0, versionCode 1, minSdk 24, targetSdk 36, launchable activity `app.minisumma.companion.MainActivity`, native code `arm64-v8a` only, 27 permissions (see "Privacy and permissions"), none of the blocked ones |
| `aapt2 dump xmltree` of the APK's manifest | `allowBackup=false`, `usesCleartextTraffic=false`, link scheme `minisumma` |
| `unzip -l` and the first bytes of `assets/index.android.bundle` | the JS bundle is embedded (2.9 MB) and is Hermes bytecode (starts `c61fbc03c103191f`); `libhermesvm.so`, `libreactnative.so`, four `classes*.dex` files and the camera barcode models are in the APK |
| a SHA-1 audit of 19 of the downloaded libraries against what Maven Central publishes next to each file | 19 of 19 match: the 12 `com.facebook.fresco:*:3.7.0` AARs that blocked the earlier runs and 7 Kotlin 2.2.10 jars (see "Build outcome") |
| `node --test scripts/gradle-network.test.mjs` (build script's reading of refused downloads) | 10 of 10 pass |
| the build script's retry loop against a fake `gradlew` that prints real Gradle 429 messages | 4 cases behave as designed: refused every time (lists servers, status and files; stops after the last run), refused once then fine (continues to signing), a compile error (not retried), retry properties you set yourself (not overridden). A fake Gradle, not a real build |

What `check:core` covers against the real core: pairing from the core's own QR link, the answers for a used, wrong, unknown and
cancelled code and for the 10-per-minute pairing limit, the snapshot reload and scopes, a live event from the desktop, the
refusal of a prompt for an unknown session, a 403 for a missing scope that does not unpair the phone, removal while connected
(close 4003) and while away (refused at connect, close 4401), and a PC that stops answering (reconnecting, then
`desktop_unreachable`, with the honest wording and the last update time).

### Build outcome: an APK was built; it has NOT been run on any device

`npm run build:apk` finished in the Linux sandbox this document was written in (Node 22, JDK 21, no phone, no emulator):

| | |
| --- | --- |
| File | `Mini-Summa-0.1.0-release-sideload.apk` (written to `~/minisumma-apk/` by the script) |
| Size | 46,206,686 bytes (44.1 MiB) |
| SHA-256 | `406b6cdc84b56d7dc0ce04b6afb9b01bfa12d337d675787b58782911a500cc08` |
| Signed with | a **throwaway local key** (`CN=Mini-Summa sideload (throwaway local key), O=local`, certificate SHA-256 `0506f6add0d964c3fc979a504d71579795b53dc2310e48c748f773e57cafe688`) that the script deleted right after signing. For sideloading on your own phone only; it cannot be updated by a later build (uninstall it first, or build with your own keystore) |
| Contents | package `app.minisumma.companion`, versionName 0.1.0, minSdk 24, targetSdk 36, `arm64-v8a` only, the Hermes JS bundle embedded, no debug flag |

Everything under "Verified" above was run on this file. **Nothing was run on a device**: the app has not been installed, started,
paired, or shown a notification. The APK is a build product, not a tested product.

**Why the first 15 attempts failed.** Maven Central answers the sandbox's requests with `429`, from Cloudflare, with the body "Your ip has
exceeded rate limits. Find out more here https://central.sonatype.org/faq/429-error/" and no `Retry-After` header. Sonatype's page says Central
now enforces consumption limits per network address, groups traffic that shares an address (hosted CI, cloud infrastructure), lifts
short blocks by itself, and that retrying harder usually makes things worse; it recommends caching and a repository manager. From here,
plain `curl` with its default User-Agent got a 429 for 11 of 24 requests sent 2.5 s apart, and HTTP/2 and HTTP/1.1 behaved alike (5 and 6 of 10
answered). The same URL answered 429 and then 200 a moment later, so it is not tied to a file. Nothing is wrong with the app.

The retry settings that were meant to cope with this **never took effect**. The file `~/.gradle/gradle.properties` used the name
`org.gradle.internal.repository.max.retries`, which Gradle 9.4.1 does not read (its classes read `...repository.max.tentatives` for POM and
module files and `org.gradle.internal.network.retry.max.attempts` for library downloads, each with an initial wait that doubles), and nothing was set for
library downloads at all. Every file therefore got Gradle's defaults: 3 tries, 1 s and 2 s apart, and after 3 failed POM lookups Gradle
switches the whole repository off for the build ("Repository MavenRepo is disabled due to earlier error"). Progress between runs came only from
what Gradle had cached by then, and the last three runs stalled on `com.facebook.fresco:*:3.7.0` AARs that each had only 3 tries.

**What produced the APK**, in this order (times are the sandbox clock):

1. The settings were corrected to 10 tries per file and a wait that starts at 1.5 s and doubles, so the last try comes about 13 minutes
   after the first. This is ordinary patience, not a way around the limit. The first run with them downloaded the Fresco AARs on the first
   try and went past the old stall for the first time; the first 194 downloads of that run had no 429 at all.
2. Then three streaks of refusals. Gradle's own backoff outlasted two: a POM (3 min 11 s, success on try 8) and the 57 KB
   `kotlin-build-tools-impl-2.2.10.jar` (6 min 23 s, success on try 9). A third file, `pika-compiler-1.1.0-2.2.10.jar`, was still refused after 9 tries over
   6.4 minutes (the 10th and last was due 6 minutes later), and a fourth (`kotlin-stdlib-jdk7-1.8.22.jar`) after 8 refused requests over 3 minutes.
3. For those, the **local verified repository** from "Build notes" was used: `scripts/android/prefetch-maven.mjs` downloaded each file
   with plain `curl` (default User-Agent, one request at a time, waiting after every 429), and the init script
   `scripts/android/local-maven.init.gradle` (copied to `~/.gradle/init.d/`) put `~/ms-maven` in front of the normal repositories,
   removing nothing. Eleven files in five modules went in this way (`kotlin-build-tools-impl` and `kotlin-stdlib-jdk7` of the Kotlin toolchain,
   `io.github.expo.pika:pika-compiler`, `org.codehaus.groovy:groovy:3.0.22`, `org.apache.httpcomponents:httpclient:4.5.6`). The jars of `pika-compiler`, `kotlin-stdlib-jdk7`,
   `groovy` and `httpclient` are not in Gradle's own cache, so the finished build can only have taken them from there.
   Two of the five modules were found by an `--offline --continue` run, which lists what is missing without touching the network.
4. The script (`node scripts/build-apk.mjs`) then ran from start to end: prebuild, Gradle (`BUILD SUCCESSFUL in 8m 35s`, no 429 in that run, eight
   Google Maven downloads for the lint tooling), signing, `apksigner verify`.

**How the dependencies were checked, and what that does not prove.**

* Nothing was loosened. TLS verification was never turned off (the sandbox's CA bundle was used as provided). No User-Agent or other
  header was changed (an earlier attempt, before this work, to send a different User-Agent was refused by the sandbox's policy and was not
  repeated), no unofficial mirror and no proxy trick was used, no credentials were used, and the app was not changed. The generated project
  has no `gradle/verification-metadata.xml`, so there is no Gradle dependency verification to bypass; this is the default for an Expo project.
  Google's mirror of Maven Central was not tried (it was not needed). The sandbox policy refused nothing during this work.
* Each of the 11 local files was compared with the SHA-1 that Maven Central publishes next to it (and with the SHA-256 where one is published: 2
  of the 11); all matched, and a file without a published checksum would have been refused. The PGP signature was verified for 4 of the 11
  (the `kotlin-build-tools-impl` and `kotlin-stdlib-jdk7` jars and POMs, one key); for the other 7 it could not be, because the signers' public
  keys are listed on keys.openpgp.org without a verified user ID, which gpg will not import. Where a signature verified, it proves "signed by that key", not who owns the key.
* A checksum fetched from the same server as the file protects against a damaged or truncated download, not against a compromised
  registry; the signature is the stronger check and exists for only part of the local files.
* Of the about 230 files Gradle downloaded itself in the last three Gradle runs (as it does in any build; counted from its `Downloading` log lines), **19 were
  audited**: the 12 Fresco AARs that had blocked the earlier runs and 7 Kotlin 2.2.10 jars, each against the SHA-1 Central publishes; 19 of 19
  matched. The rest were not audited individually. For the four files that both Gradle and the prefetch tool had downloaded independently
  (the `kotlin-build-tools-impl` jar and POM, the `pika-compiler` POM and module), the SHA-1 values were identical.

**What you need to do.** On a network where Maven Central answers normally, run the same `npm run build:apk` (about 9 minutes with a warm Gradle cache;
a first build downloads far more). On a throttled network, follow "Build notes" ("HTTP 429 from Maven Central"). If you want a fresh APK of the
same sources signed with a key you keep, set `MINISUMMA_KEYSTORE` as described under "Signing".

### Not tested

There is no phone, emulator, Firebase project or Tailscale network here, so none of this was exercised:

* installing the built APK and starting the app on a real device or emulator (it has had static checks only: signature, manifest,
  contents), and how it looks and feels (layout, fonts, touch targets, the keyboard over the compose screen with edge to edge insets,
  the bottom tab bar, sheets and the toast position)
* scanning a QR code with the camera, and the Android permission prompts
* push delivery, FCM token registration, notification channel behavior, and what a tap on a notification does on a cold start
* a real Tailscale connection, a real `tailscale serve` address and its certificate, and the TLS error wording on a real device
  (React Native reports most connection failures as the same error, so the "certificate or HTTPS" message is a best effort)
* the real desktop UI (the Electron app): only its headless core was used
* R8/ProGuard (off), other CPU types (arm64 only), and Android versions other than the ones the build targets (minSdk 24, target 36)

### Known gaps

* A connection that dies silently (for example when the phone switches from Wi-Fi to mobile data) is noticed by the SDK's ping
  check within about 70 seconds. Until then the app can still look live. A clean close is noticed at once.
* The manual pairing form needs the **offer ID** as well as the code, because `pairing.redeem` requires both. The desktop should
  show all three (address, offer id, code), or a copyable `minisumma://pair?...` link.
* The app keeps one address per pairing (the first one that answered). If the PC is reachable by another address later, pair again.
* Reports and activity are loaded as the newest 100 each, with "Load older" for more. There is no search.
* There is no terminal view and no way to start or stop sessions from the phone: those need the desktop scope, which phones do not get.
