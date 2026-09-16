#!/bin/sh
# Typecheck against the installed OpenClaw's SDK types and its bundled tsc.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tsc=$(sh "$root/scripts/openclaw-sdk.sh")
exec node "$tsc" --noEmit -p "$root/tsconfig.json"
