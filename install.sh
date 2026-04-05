#!/usr/bin/env bash

set -euo pipefail

REPO="chenhunghan/mdg"
BIN_NAME="mdg"
INSTALL_DIR="${MDG_INSTALL_DIR:-$HOME/.local/bin}"
VERSION_FILE="${INSTALL_DIR}/.mdg-version"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'mdg installer: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "${TMP_DIR:-}" ] && [ -d "${TMP_DIR:-}" ]; then
    rm -rf "$TMP_DIR"
  fi
}

trap cleanup EXIT INT TERM

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    OS="windows"
    BIN_NAME="mdg.exe"
    ;;
  *) fail "unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) ARCH="x64" ;;
  arm64 | aarch64) ARCH="arm64" ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")"
LATEST_TAG=""
while IFS= read -r line; do
  case "$line" in
    *'"tag_name": '*)
      LATEST_TAG="${line#*\"tag_name\": \"}"
      LATEST_TAG="${LATEST_TAG%%\"*}"
      break
      ;;
  esac
done <<EOF
$RELEASE_JSON
EOF

[ -n "$LATEST_TAG" ] || fail "could not determine latest release tag"

mkdir -p "$INSTALL_DIR"

if [ -x "${INSTALL_DIR}/${BIN_NAME}" ] && [ -f "$VERSION_FILE" ]; then
  CURRENT_TAG="$(cat "$VERSION_FILE")"
  if [ "$CURRENT_TAG" = "$LATEST_TAG" ]; then
    log "mdg ${LATEST_TAG} is already installed at ${INSTALL_DIR}/${BIN_NAME}"
    exit 0
  fi
fi

case "$OS" in
  windows) ARCHIVE_NAME="mdg-${OS}-${ARCH}.zip" ;;
  *) ARCHIVE_NAME="mdg-${OS}-${ARCH}.tar.gz" ;;
esac
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${ARCHIVE_NAME}"

TMP_DIR="$(mktemp -d)"
ARCHIVE_PATH="${TMP_DIR}/${ARCHIVE_NAME}"

log "Downloading ${LATEST_TAG} for ${OS}/${ARCH}..."
curl -fsSL "$DOWNLOAD_URL" -o "$ARCHIVE_PATH"

extract_archive() {
  case "$1" in
    *.tar.gz)
      tar -xzf "$1" -C "$2"
      ;;
    *.zip)
      if ! tar -xf "$1" -C "$2" >/dev/null 2>&1; then
        command -v unzip >/dev/null 2>&1 || fail "zip archive requires tar with zip support or unzip"
        unzip -q "$1" -d "$2"
      fi
      ;;
    *) fail "unsupported archive format: $1" ;;
  esac
}

extract_archive "$ARCHIVE_PATH" "$TMP_DIR"

[ -f "${TMP_DIR}/${BIN_NAME}" ] || fail "release archive did not contain ${BIN_NAME}"

cp "${TMP_DIR}/${BIN_NAME}" "${INSTALL_DIR}/${BIN_NAME}.new"
chmod 755 "${INSTALL_DIR}/${BIN_NAME}.new"
mv -f "${INSTALL_DIR}/${BIN_NAME}.new" "${INSTALL_DIR}/${BIN_NAME}"

printf '%s\n' "$LATEST_TAG" > "${VERSION_FILE}.new"
mv -f "${VERSION_FILE}.new" "$VERSION_FILE"

log "Installed ${BIN_NAME} ${LATEST_TAG} to ${INSTALL_DIR}/${BIN_NAME}"

case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    log "Add ${INSTALL_DIR} to your PATH if it is not already there."
    ;;
esac
