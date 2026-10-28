#!/bin/sh
# run.sh — start one sync run. Safe to call from cron, a systemd timer or a NAS task scheduler.
# All arguments are passed to sync.mjs; logging goes to the state directory (`sync.log`).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CONFIG=${HBA_CONFIG:-$HERE/config.json}

# Reads a string value from config.json without needing node yet (node is what we are looking for).
cfg_string() {
  [ -f "$CONFIG" ] || return 0
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CONFIG" | head -n 1
}

# ~/ at the start of a configured path means "relative to $HOME".
expand_tilde() {
  case "$1" in
  "~") printf '%s' "$HOME" ;;
  "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
  *) printf '%s' "$1" ;;
  esac
}

NODE_BIN=${HBA_NODE_BIN:-$(expand_tilde "$(cfg_string nodeBin)")}
[ -n "${NODE_BIN:-}" ] || NODE_BIN=node

if ! command -v "$NODE_BIN" >/dev/null 2>&1 && [ ! -x "$NODE_BIN" ]; then
  echo "run.sh: node not found ('$NODE_BIN') — set nodeBin in $CONFIG or HBA_NODE_BIN" >&2
  exit 127
fi

cd "$HERE" || exit 1
exec "$NODE_BIN" sync.mjs "$@"
