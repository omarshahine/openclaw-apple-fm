#!/bin/sh
# Typecheck against the installed OpenClaw's SDK types and its bundled tsc, so the
# repo needs no network install. Set OPENCLAW_ROOT to point at a different install.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
openclaw_root=${OPENCLAW_ROOT:-"$(npm root -g)/openclaw"}

if [ ! -d "$openclaw_root" ]; then
  echo "openclaw not found at $openclaw_root; install it (npm i -g openclaw) or set OPENCLAW_ROOT" >&2
  exit 1
fi

tsc="$openclaw_root/node_modules/typescript/bin/tsc"
[ -x "$tsc" ] || tsc="$root/node_modules/typescript/bin/tsc"
if [ ! -f "$tsc" ]; then
  echo "no TypeScript compiler found (looked in $openclaw_root and $root)" >&2
  exit 1
fi

# Resolve bare "openclaw/..." imports without vendoring the package.
mkdir -p "$root/node_modules"
ln -sfn "$openclaw_root" "$root/node_modules/openclaw"
[ -d "$openclaw_root/node_modules/@types/node" ] && ln -sfn "$openclaw_root/node_modules/@types" "$root/node_modules/@types"

exec node "$tsc" --noEmit -p "$root/tsconfig.json"
