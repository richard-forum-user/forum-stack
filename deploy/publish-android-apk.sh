#!/bin/bash
set -euo pipefail

APP_NAME="Forum Personal Pod"
APP_BUILD="${APP_BUILD:-secure-pod-v1.5}"
APK_SOURCE="${APK_SOURCE:-$HOME/Desktop/forum-stack/forum-pod/android/app/build/outputs/apk/debug/app-debug.apk}"
RELEASE_DIR="${RELEASE_DIR:-$HOME/Desktop/forum-releases}"
PUBLIC_HOST="${PUBLIC_HOST:-apk.yourcommunity.forum}"
STABLE_APK="forum-personal-pod-${APP_BUILD}.apk"

if [ ! -f "$APK_SOURCE" ]; then
  echo "Missing APK: $APK_SOURCE"
  echo "Build it first: bash $HOME/Desktop/deploy/build-android-apk.sh"
  exit 1
fi

mkdir -p "$RELEASE_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
versioned_apk="forum-personal-pod-${APP_BUILD}-${stamp}.apk"

cp "$APK_SOURCE" "$RELEASE_DIR/$versioned_apk"
cp "$APK_SOURCE" "$RELEASE_DIR/$STABLE_APK"

(
  cd "$RELEASE_DIR"
  sha256sum "$versioned_apk" "$STABLE_APK" > SHA256SUMS.txt
  # Include zk-email artifacts if present so users can sanity-check them.
  if [ -d zk-email ]; then
    ( cd zk-email && sha256sum *.wasm *.zkey *.json 2>/dev/null || true ) \
      | sed 's|^|zk-email/|' >> SHA256SUMS.txt
  fi
)

cat > "$RELEASE_DIR/index.html" <<EOF
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${APP_NAME} Android Download</title>
  <style>
    body { margin: 0; background: #090b0f; color: #d1d5db; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 18px; }
    a.button { display: inline-block; margin: 18px 0; padding: 12px 16px; border-radius: 8px; background: #1f6feb; color: white; text-decoration: none; font-weight: 700; }
    code, pre { background: #111827; border: 1px solid #22272e; border-radius: 8px; }
    code { padding: 2px 5px; }
    pre { padding: 12px; overflow-x: auto; white-space: pre-wrap; }
    .muted { color: #8b949e; }
  </style>
</head>
<body>
  <main>
    <h1>${APP_NAME}</h1>
    <p class="muted">Latest Android debug APK (build ${APP_BUILD}) published at ${stamp} UTC.</p>
    <a class="button" href="/${STABLE_APK}">Download latest APK</a>
    <p>Direct link:</p>
    <pre>https://${PUBLIC_HOST}/${STABLE_APK}</pre>
    <p class="muted">After download, Android may ask you to allow installs from this browser.</p>
    <h2>Checksum</h2>
    <pre>$(cd "$RELEASE_DIR" && sha256sum "$STABLE_APK")</pre>
    <p><a href="/SHA256SUMS.txt">SHA256SUMS.txt</a></p>
  </main>
</body>
</html>
EOF

echo "Published APK release:"
echo "  $RELEASE_DIR/$STABLE_APK"
echo "  https://$PUBLIC_HOST/$STABLE_APK"
