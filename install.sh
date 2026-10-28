#!/bin/sh
# install.sh — one-time setup in this directory: dependencies and the directories from config.json.
# Requires node >= 24.5 with npm on PATH (or a nodeBin in config.json / HBA_NODE_BIN).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
CONFIG=${HBA_CONFIG:-$HERE/config.json}

cfg_string() {
  [ -f "$CONFIG" ] || return 0
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CONFIG" | head -n 1
}

expand_tilde() {
  case "$1" in
  "~") printf '%s' "$HOME" ;;
  "~/"*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
  *) printf '%s' "$1" ;;
  esac
}

NODE_BIN=${HBA_NODE_BIN:-$(expand_tilde "$(cfg_string nodeBin)")}
[ -n "${NODE_BIN:-}" ] || NODE_BIN=node
# npm is a script with `#!/usr/bin/env node`, so node must be on PATH for it.
if [ "$NODE_BIN" != "node" ]; then
  PATH="$(dirname "$(command -v "$NODE_BIN" || printf '%s' "$NODE_BIN")"):$PATH"
  export PATH
fi

cd "$HERE"
echo "== homebase2-archive install =="
echo "node: $("$NODE_BIN" -v 2>/dev/null || echo MISSING)"

"$NODE_BIN" -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 5)) {
  console.error(`node ${process.versions.node} is too old: 24.5 or newer is required`);
  process.exit(1);
}
' || exit 1

"$NODE_BIN" -e '
const { loadConfig } = await import("./lib/config.mjs");
const { mkdirSync } = await import("node:fs");
const { existsSync } = await import("node:fs");
const cfg = loadConfig();
mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
mkdirSync(cfg.outDir, { recursive: true });
console.log(`config: ${cfg.configFound ? cfg.configFile : "(none — defaults in use)"}`);
console.log(`state:  ${cfg.stateDir}`);
console.log(`output: ${cfg.outDir}`);
if (!existsSync(cfg.credentialsFile)) {
  console.log(`NOTE:   no credentials file at ${cfg.credentialsFile}`);
}
' --input-type=module

# `npm ci` never rewrites the lockfile; `npm install --omit=dev` does, and the resulting local change
# then blocks `git pull` on a deployment that tracks this repository.
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi

cat <<EOF

Done. Next steps:
  $HERE/run.sh --print-config   # verify the resolved settings
  $HERE/run.sh --list           # what is on the station (downloads nothing)
  $HERE/run.sh --limit 3        # small test run
  $HERE/run.sh                  # regular run
EOF
