#!/bin/bash
# Build a release-signed Android APK for distribution.
#
# Prereq: a release keystore on disk and a gradle.properties (or env
# vars) describing it. Create the keystore once:
#
#   keytool -genkey -v \
#     -keystore ~/keystores/forum-release.keystore \
#     -alias forum-personal-pod \
#     -keyalg RSA -keysize 2048 -validity 10000
#
# Then write ~/.gradle/gradle.properties:
#
#   FORUM_RELEASE_STORE_FILE=/home/forum-user1/keystores/forum-release.keystore
#   FORUM_RELEASE_STORE_PASSWORD=...
#   FORUM_RELEASE_KEY_ALIAS=forum-personal-pod
#   FORUM_RELEASE_KEY_PASSWORD=...
#
# DO NOT commit gradle.properties or the keystore to git. Lose the
# keystore and you can never publish an update for the same package
# name without resetting users.
#
# Output:
#   $POD_DIR/android/app/build/outputs/apk/release/app-release.apk

set -euo pipefail

POD_DIR="${FORUM_POD_DIR:-$HOME/Desktop/forum-stack/forum-pod}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"

cd "$POD_DIR"

if [ -z "${FORUM_RELEASE_STORE_FILE:-}" ]; then
  # Source from ~/.gradle/gradle.properties if present so the user
  # doesn't have to re-export the values every shell.
  if [ -f "$HOME/.gradle/gradle.properties" ]; then
    set -a
    # shellcheck disable=SC1090
    . <(grep -E '^FORUM_RELEASE_' "$HOME/.gradle/gradle.properties" | sed 's/[[:space:]]*=[[:space:]]*/=/')
    set +a
  fi
fi

if [ -z "${FORUM_RELEASE_STORE_FILE:-}" ] || \
   [ -z "${FORUM_RELEASE_STORE_PASSWORD:-}" ] || \
   [ -z "${FORUM_RELEASE_KEY_ALIAS:-}" ] || \
   [ -z "${FORUM_RELEASE_KEY_PASSWORD:-}" ]; then
  echo "FORUM_RELEASE_* not set. Generating an unsigned-looking build is" >&2
  echo "still possible via assembleRelease (debug-signed fallback)," >&2
  echo "but the output is NOT distributable. See the header of this script." >&2
fi

if command -v java >/dev/null 2>&1; then
  JAVA_BIN="$(readlink -f "$(command -v java)")"
  JAVA_HOME_DETECTED="$(dirname "$(dirname "$JAVA_BIN")")"
  if [ -d "$JAVA_HOME_DETECTED" ]; then
    export JAVA_HOME="$JAVA_HOME_DETECTED"
  fi
fi

export ANDROID_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

echo "Using Node: $(node --version)"
echo "Using Java: $(java -version 2>&1 | head -n 1)"

echo "Wiping stale build outputs..."
rm -rf dist android/app/src/main/assets/public
rm -f android/app/build/outputs/apk/release/app-release.apk

echo "Installing dependencies..."
npm install
npm prune
npm install @capacitor/core@6 @capacitor/cli@6 @capacitor/android@6 --save-dev --save-exact

echo "Building web assets..."
VITE_BASE=./ npm run build

if [ ! -d android ]; then
  echo "Generating Capacitor Android project..."
  npx cap add android
fi

echo "Syncing web assets into Android project..."
npx cap sync android

if [ ! -x android/gradlew ]; then
  echo "android/gradlew missing or not executable." >&2
  exit 1
fi

echo "Building release APK..."
(cd android && ./gradlew assembleRelease)

APK="$POD_DIR/android/app/build/outputs/apk/release/app-release.apk"
if [ ! -f "$APK" ]; then
  echo "Gradle did not produce app-release.apk." >&2
  exit 1
fi

sha256sum "$APK"
echo ""
echo "APK ready:"
echo "$APK"
