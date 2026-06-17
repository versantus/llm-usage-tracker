#!/usr/bin/env bash
# Compile the `lut` CLI into standalone binaries with `bun build --compile`.
#
#   ./scripts/build-cli.sh            # native binary -> dist/lut
#   ./scripts/build-cli.sh --all      # cross-compile every release target
#
# Requires bun. The output binaries embed the bun runtime, so they run with no
# bun/node/npx present — which is what the Claude Code hook needs.
set -euo pipefail
cd "$(dirname "$0")/.."

ENTRY="cli/lut.ts"
OUT_DIR="dist"
mkdir -p "$OUT_DIR"

# Map a bun --target to the asset name install.sh expects (os-arch).
build_target() {
    local target="$1" asset="$2"
    echo "==> $asset"
    bun build --compile --minify --sourcemap=none \
        --target="$target" "$ENTRY" --outfile "$OUT_DIR/$asset"
}

if [[ "${1:-}" == "--all" ]]; then
    build_target bun-darwin-arm64  lut-darwin-arm64
    build_target bun-darwin-x64    lut-darwin-x64
    build_target bun-linux-x64     lut-linux-x64
    build_target bun-linux-arm64   lut-linux-arm64
    build_target bun-windows-x64   lut-windows-x64.exe
    echo "==> built $(ls "$OUT_DIR" | tr '\n' ' ')"
else
    bun build --compile --minify --sourcemap=none "$ENTRY" --outfile "$OUT_DIR/lut"
    echo "==> built $OUT_DIR/lut"
fi
