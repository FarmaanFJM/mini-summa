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

* Android 7.0 or newer, 64-bit ARM (arm64). Nearly every phone since 2017 is. See "Other CPUs" below for x86 or 32-bit.
* The Tailscale app, signed in to the **same tailnet** as the PC, with the VPN switched on while you use Mini-Summa.

In your tailnet (admin console, DNS page): MagicDNS on and **HTTPS Certificates** enabled. Without them `tailscale serve`
cannot give the PC an `https` address, and Android refuses plain `http` addresses to other devices.

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

The same by hand:

```bash
npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleRelease
```

### Signing

A release APK must be signed before Android installs it. Unless you provide a key, the script creates a **throwaway local
key** under `~/.android-build-keys/` with a random password that only exists in the script's memory, signs, verifies, and
deletes the key. That APK is for sideloading on your own phone only. Because the key is gone, a later build has a different
signature: uninstall the old app first (you will pair again). To keep one identity so updates install over the old app:

```bash
MINISUMMA_KEYSTORE=/path/to/your.jks MINISUMMA_KEYSTORE_PASSWORD=... MINISUMMA_KEY_ALIAS=yourAlias npm run build:apk
```

Keep that keystore out of the repository. Do not add a `google-services.json` unless it is your own (see Push below).

### Build notes

* **CPU:** the default is `arm64-v8a` only, which keeps the native build short. For other CPUs set
  `MINISUMMA_ARCHS=arm64-v8a,armeabi-v7a,x86_64` (a much longer build).
* **Gradle** is downloaded by the wrapper (9.4.1), and Android Gradle Plugin 9.2.1 and the React Native artifacts come from
  Google Maven, Maven Central, the Gradle Plugin Portal and JitPack. A first build downloads about 2 GB.
* **HTTP 429 from Maven Central.** On a shared network address Maven Central may answer `429 Too Many Requests`. Gradle then
  retries three times and gives up with "Plugin ... was not found" (the real cause, HTTP 429, shows with `--info`). Make Gradle
  more patient in `~/.gradle/gradle.properties` (outside the repository):
  ```
  systemProp.org.gradle.internal.repository.max.tentatives=8
  systemProp.org.gradle.internal.repository.initial.backoff=1000
  org.gradle.workers.max=2
  org.gradle.parallel=false
  ```
  The first build is then slow (it waits out the 429s); later builds use Gradle's cache.
* R8 shrinking is switched off (`expo-build-properties`), so an APK that could not be run on a device while it was built does
  not also depend on untested keep rules. Turn it on in `app.config.ts` if you want a smaller APK.

## Install (sideload)

1. Copy the APK to the phone (USB, a cloud drive, or `adb install -r Mini-Summa-0.1.0-release-sideload.apk`).
2. If you open it from a file manager or a browser, Android asks to allow "Install unknown apps" for that app. Allow it for
   the install only.
3. Play Protect may warn that the app is from an unknown developer. That is expected for a self-signed APK.
4. Check the SHA-256 the build printed against `sha256sum` of the file you installed.

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
the PC. If you remove the phone on the PC first, the app notices (HTTP 401, or the live connection closing with code 4003), wipes
its token and shows "This phone was removed in Mini-Summa. Pair again."

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

Permissions: network, camera (QR scan), notifications. Storage, overlay and microphone permissions are blocked. Android cloud
backup is off so the token cannot leave the phone that way. The phone never caches report bodies, and no source file imports a
storage library other than the secure credential store (a test enforces that). Two things leave the app on your request: **Copy**
puts the report on the Android clipboard (other apps may be able to read the clipboard, so copy something else afterwards if the
report is sensitive) and **Share** hands the text to the app you pick.

## Verified and NOT TESTED

Verified here (commands run from `apps/android`):

| What | Result |
| --- | --- |
| `npx tsc --noEmit` (app, tests, and the shared SDK source) and `-p tsconfig.config.json` | clean |
| `npx jest` (jest-expo and React Native Testing Library) | 13 suites, 186 tests pass |
| `npx expo-doctor` | 20 of 20 checks pass |
| `npx expo export --platform android` (Metro, Hermes bytecode) | bundles 1,408 modules |
| `npx expo install --check` | dependencies match SDK 58 |

BUILD_OUTCOME_PLACEHOLDER

**Not tested, because there is no phone, emulator, Firebase project or Tailscale network here:**

* installing and starting the app on a real device or emulator, and how it looks and feels (layout, fonts, touch targets, the
  keyboard over the compose screen, edge to edge insets, the bottom tab bar, sheets and the toast position)
* scanning a QR code with the camera, and the Android permission prompts
* push delivery, FCM token registration, channel behavior, and what a tap from a notification does on a cold start
* a real Tailscale connection, a real `tailscale serve` address and its certificate, and TLS error wording on a real device
  (React Native reports most connection failures as the same error, so the app's "certificate or HTTPS" message is a best effort)
* a real desktop core: the tests run against a fake core that speaks the shared route table, not the real server. The
  WebSocket close code 4003 and the error codes used for expired or used pairing codes are matched loosely because the real
  server did not exist yet when this was written
* R8/ProGuard, other CPU types, and Android versions other than the ones the build targets (minSdk 24, target 36)

Known gaps:

* A connection that dies silently (for example when the phone switches from Wi-Fi to mobile data) is noticed by the SDK's ping
  check within about 70 seconds. Until then the app can still look live. A clean close is noticed at once.
* The manual pairing form needs the **offer ID** as well as the code, because `pairing.redeem` requires both. The desktop should
  show all three (address, offer id, code), or a copyable `minisumma://pair?...` link.
* The app keeps one address per pairing (the first one that answered). If the PC is reachable by another address later, pair again.
* Reports and activity are loaded as the newest 100 each, with "Load older" for more. Search is not included.
* There is no terminal view and no way to start or stop sessions from the phone: those need the desktop scope, which phones do not get.
