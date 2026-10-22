#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
if [ -n "${ARAYA_INSTALL_PREFIX:-}" ]; then
  PREFIX=$ARAYA_INSTALL_PREFIX
else
  : "${HOME:?set HOME or ARAYA_INSTALL_PREFIX}"
  PREFIX=$HOME/.local
fi
PACK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/araya-deploy.XXXXXX")

cleanup() {
  rm -rf "$PACK_DIR"
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

cd "$REPO_ROOT"
npm pack --pack-destination "$PACK_DIR"
set -- "$PACK_DIR"/*.tgz
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  printf 'error: expected exactly one package tarball in %s\n' "$PACK_DIR" >&2
  exit 1
fi

npm uninstall --global --prefix "$PREFIX" --no-audit --no-fund agentctl
# 同名・同versionの既存symlinkをnpmがup-to-date扱いしないよう強制置換する。
npm install --global --prefix "$PREFIX" --no-audit --no-fund --force "$1"
