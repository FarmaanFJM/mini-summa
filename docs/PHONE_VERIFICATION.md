# Verifying Mini-Summa on your Android phone

The phone app has been built and checked as a file (signature, permissions, manifest, bundle), its 216 tests and a script that runs its
own pairing and connection code against the real core pass, but **it has never been installed or run on a phone or an emulator**. This
is the checklist for that first run, about 30 minutes. Install details are in [ANDROID.md](ANDROID.md) ("Install on your phone");
here each step says what to do and what you should see. If something differs, write down the number and what you saw.

You need: the APK (`Mini-Summa-0.1.0-release-sideload.apk`, 64-bit ARM, Android 7.0 or newer), Mini-Summa running on your PC with one
project, a managed Claude session in it (press **New session**), and Tailscale installed and signed in on the PC and the phone with
the **same account**. In the Tailscale admin console, **HTTPS certificates** must be enabled for your tailnet (DNS page), because the
phone only talks to the PC over HTTPS.

## 1. Install

1. Check the file: on the PC `sha256sum Mini-Summa-0.1.0-release-sideload.apk` (PowerShell: `Get-FileHash -Algorithm SHA256 <file>`)
   must equal the SHA-256 in [ANDROID.md](ANDROID.md), "Build outcome". If it does not, stop.
2. Install it (`adb install -r <file>` with USB debugging, or copy the file to the phone and tap it; allow "Install unknown apps" for
   the app you opened it from).
   *Expect:* Play Protect warns about an unknown developer (the key is a throwaway one). Choose **More details**, then **Install anyway**.
3. Open **Mini-Summa**.
   *Expect:* a dark screen, then **Pair this phone** with **Allow camera** and **Enter the code by hand**. No notification prompt yet.

## 2. Let the phone reach the PC

4. In Mini-Summa on the PC: **Settings, Remote access**, switch on **Allow my phone to reach Mini-Summa through Tailscale Serve**.
   *Expect:* the page shows an `https://<your-pc>.<tailnet>.ts.net` address. If it shows a problem instead (Tailscale not running, HTTPS
   certificates off, Funnel detected), it says what to do in words; fix that first. Mini-Summa never turns on Funnel.

## 3. Pair

5. **Settings, Phones and devices, Pair a phone.** Tick the permissions this phone may have: **Read**, **Notify**, **Prompt**, **Approve**
   (leave **Trusted** off). *Expect:* a QR code and a code with a 5-minute countdown.
6. On the phone press **Allow camera**, allow it, scan the QR code, check the PC's name, press **Pair with ...**.
   *Expect:* the phone shows your projects and a "connected" status; on the PC the phone appears in the list as "last seen over Tailscale".
7. Pair again with the same code. *Expect:* refused ("already used"); the first pairing is untouched.

## 4. Read

8. On the phone open each project, **Activity** and a **Report**.
   *Expect:* the same projects, sessions, activity and report text you see on the PC. Start a session or finish a task on the PC:
   *expect* the phone to update within a few seconds while the app is open.

## 5. Intervene, with your approval

9. In a managed session on the PC ask Claude to create a file (it will ask permission).
   *Expect:* the phone shows "needs permission" with the tool and a short excerpt. Press **Approve** on the phone: *expect* the dialog on
   the PC terminal to close once and Claude to continue. Do it again and press **Reject**: *expect* nothing created.
10. On the phone send a short prompt to that session ("Reply with the word ok").
    *Expect:* it does **not** reach Claude yet; the PC shows it waiting for your approval (because the phone is not trusted). Approve it on
    the PC: *expect* Claude receives exactly that text and answers.
11. Send a prompt that starts with `/` or `!` from the phone. *Expect:* refused with "Text that starts with ! or / is a Claude Code command, not a prompt, and cannot be sent from a phone."
12. Send a prompt for a session you started in an ordinary terminal (not through Mini-Summa).
    *Expect:* refused: Mini-Summa only types into sessions it started itself.

## 6. Notifications

13. **Settings** in the phone app, **Send a test notification** (Android 13 and newer first asks for the notification permission).
    *Expect:* a notification on the phone. Without a Firebase project (the APK is built without one) it is shown while the app is
    open; with the app closed nothing arrives. That is expected: closed-app push needs your own Firebase project
    ([ANDROID.md](ANDROID.md), "Push notifications"). If you set one up: *expect* a push with the project name, a fixed sentence
    ("A report is ready") and no report text.

## 7. Lose and regain contact

14. Turn off Wi-Fi on the PC (or sign Tailscale out on it) for a minute.
    *Expect:* the phone says the PC may be asleep, offline or not on Tailscale and shows when it last had contact; it does not show old
    data as current. Reconnect: *expect* it recovers without pairing again.

## 8. Remove

15. On the PC, **Settings, Phones and devices**, remove the phone.
    *Expect:* the phone drops to the pairing screen at once with a message that it was removed; its token no longer works.

## Please send back

Which numbered steps passed, which did not, and for each failure what the phone and the PC showed. Do not send tokens, pairing codes
or report text.
