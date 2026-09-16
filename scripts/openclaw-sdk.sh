#!/bin/sh
# Shared helper: link the installed OpenClaw so bare "openclaw/plugin-sdk/*" imports
# resolve, and print the TypeScript compiler path. OpenClaw ships tsc, so the plugin
# needs no npm dependencies of its own (it is also os: darwin, which blocks
# `npm install` of this package on Linux runners).
#
# Usage: tsc=$(sh scripts/openclaw-sdk.sh) || exit 1
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
openclaw_root=${OPENCLAW_ROOT:-"$(npm root -g)/openclaw"}

if [ ! -d "$openclaw_root" ]; then
  echo "openclaw not found at $openclaw_root; install it (npm i -g openclaw) or set OPENCLAW_ROOT" >&2
  exit 1
fi

tsc="$openclaw_root/node_modules/typescript/bin/tsc"
[ -f "$tsc" ] || tsc="$root/node_modules/typescript/bin/tsc"
if [ ! -f "$tsc" ]; then
  echo "no TypeScript compiler found (looked in $openclaw_root and $root)" >&2
  exit 1
fi

mkdir -p "$root/node_modules"
ln -sfn "$openclaw_root" "$root/node_modules/openclaw"
[ -d "$openclaw_root/node_modules/@types" ] && ln -sfn "$openclaw_root/node_modules/@types" "$root/node_modules/@types"

echo "$tsc"
