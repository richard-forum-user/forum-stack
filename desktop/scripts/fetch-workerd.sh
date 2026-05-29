#!/usr/bin/env bash
# Downloads platform-specific workerd binaries for the Tauri sidecar.
# Each binary is renamed to the Rust target triple, which is what Tauri
# expects in `src-tauri/binaries/`.
#
# Usage:
#   ./scripts/fetch-workerd.sh                  # current host only
#   ./scripts/fetch-workerd.sh all              # every target (CI)
#
# Override with WORKERD_VERSION=v1.20250528.0 to pin a release.

set -euo pipefail

WORKERD_VERSION="${WORKERD_VERSION:-latest}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/binaries"
mkdir -p "$OUT_DIR"

resolve_latest() {
  curl -fsSL https://api.github.com/repos/cloudflare/workerd/releases/latest \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' \
    | head -n1
}

if [ "$WORKERD_VERSION" = "latest" ]; then
  WORKERD_VERSION="$(resolve_latest)"
fi
echo "workerd version: $WORKERD_VERSION"

# Asset names on github.com/cloudflare/workerd/releases.
# Bash 3.2 (default macOS shell) does not support `declare -A`, so we
# resolve via a case statement instead of an associative array.
asset_for() {
  case "$1" in
    x86_64-unknown-linux-gnu)   echo "workerd-linux-64.gz" ;;
    aarch64-unknown-linux-gnu)  echo "workerd-linux-arm64.gz" ;;
    x86_64-apple-darwin)        echo "workerd-darwin-64.gz" ;;
    aarch64-apple-darwin)       echo "workerd-darwin-arm64.gz" ;;
    x86_64-pc-windows-msvc)     echo "workerd-windows-64.exe" ;;
    *)                          echo "" ;;
  esac
}

ALL_TRIPLES="x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-apple-darwin aarch64-apple-darwin x86_64-pc-windows-msvc"

fetch_one() {
  local triple="$1"
  local asset="$(asset_for "$triple")"
  if [ -z "$asset" ]; then
    echo "Unknown target triple: $triple" >&2
    return 1
  fi
  local url="https://github.com/cloudflare/workerd/releases/download/${WORKERD_VERSION}/${asset}"
  local out_basename="workerd-${triple}"
  if [[ "$triple" == *windows* ]]; then
    out_basename="${out_basename}.exe"
    echo "→ ${triple}: ${url}"
    curl -fL "$url" -o "${OUT_DIR}/${out_basename}"
  else
    echo "→ ${triple}: ${url}"
    curl -fL "$url" -o "${OUT_DIR}/${out_basename}.gz"
    gunzip -f "${OUT_DIR}/${out_basename}.gz"
    chmod +x "${OUT_DIR}/${out_basename}"
  fi
}

current_triple() {
  local kernel arch
  kernel="$(uname -s)"
  arch="$(uname -m)"
  case "${kernel}-${arch}" in
    Linux-x86_64)  echo "x86_64-unknown-linux-gnu" ;;
    Linux-aarch64) echo "aarch64-unknown-linux-gnu" ;;
    Darwin-x86_64) echo "x86_64-apple-darwin" ;;
    Darwin-arm64)  echo "aarch64-apple-darwin" ;;
    MINGW*|MSYS*|CYGWIN*)  echo "x86_64-pc-windows-msvc" ;;
    *) echo "unknown" ;;
  esac
}

if [ "${1:-}" = "all" ]; then
  for triple in $ALL_TRIPLES; do
    fetch_one "$triple"
  done
else
  triple="$(current_triple)"
  if [ "$triple" = "unknown" ]; then
    echo "Unrecognised host platform; use './fetch-workerd.sh all'." >&2
    exit 1
  fi
  fetch_one "$triple"
fi

echo "Done. workerd binaries are in ${OUT_DIR}/"
