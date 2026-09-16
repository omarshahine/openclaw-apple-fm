#!/bin/sh
# Emit dist/ for publishing, using the installed OpenClaw's bundled tsc.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tsc=$(sh "$root/scripts/openclaw-sdk.sh")
node -e "require('node:fs').rmSync('$root/dist', { recursive: true, force: true })"
exec node "$tsc" -p "$root/tsconfig.build.json"
