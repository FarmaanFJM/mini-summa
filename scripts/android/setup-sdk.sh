#!/usr/bin/env bash
# Installs the Android command-line tools and the SDK pieces the Expo app needs to build an APK.
# Everything lands outside the repository (default: ~/android-sdk). Safe to re-run.
#
#   scripts/android/setup-sdk.sh                      # cmdline-tools, licenses, platform-tools
#   scripts/android/setup-sdk.sh --full               # also platform, build-tools, NDK, CMake used by Expo SDK 58
#
# Environment:
#   ANDROID_SDK_ROOT   install location (default: $HOME/android-sdk)
#   CMDLINE_TOOLS_REV  command-line tools revision (default below)
set -euo pipefail

SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
REV="${CMDLINE_TOOLS_REV:-13114758}"
FULL=0
for arg in "$@"; do [ "$arg" = "--full" ] && FULL=1; done

mkdir -p "$SDK_ROOT/cmdline-tools"
if [ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading Android command-line tools $REV"
  curl -fsSL -o "$tmp/cmdline-tools.zip" "https://dl.google.com/android/repository/commandlinetools-linux-${REV}_latest.zip"
  unzip -q "$tmp/cmdline-tools.zip" -d "$tmp/unpacked"
  rm -rf "$SDK_ROOT/cmdline-tools/latest"
  mv "$tmp/unpacked/cmdline-tools" "$SDK_ROOT/cmdline-tools/latest"
fi

SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-}"

# Licence acceptance is explicit and scripted here because this is a non-interactive build machine.
# `yes` exits with SIGPIPE when sdkmanager stops reading, so tolerate that.
set +o pipefail
yes | "$SDKMANAGER" --sdk_root="$SDK_ROOT" --licenses >/dev/null 2>&1 || true
set -o pipefail

"$SDKMANAGER" --sdk_root="$SDK_ROOT" "platform-tools"

if [ "$FULL" = "1" ]; then
  PLATFORM="${ANDROID_PLATFORM:-android-36}"
  BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-36.0.0}"
  NDK="${ANDROID_NDK:-27.1.12297006}"
  CMAKE="${ANDROID_CMAKE:-3.22.1}"
  "$SDKMANAGER" --sdk_root="$SDK_ROOT" "platforms;${PLATFORM}" "build-tools;${BUILD_TOOLS}" "ndk;${NDK}" "cmake;${CMAKE}"
fi

echo "Android SDK ready at $SDK_ROOT"
echo "export ANDROID_HOME=$SDK_ROOT ANDROID_SDK_ROOT=$SDK_ROOT"
