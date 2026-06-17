#!/usr/bin/env bash
# Build UsageTracker.app — a native SwiftUI menu-bar + dashboard app.
#
#   ./build.sh            # release build -> ./UsageTracker.app
#   ./build.sh --debug    # debug build
#   ./build.sh --run      # build then launch
#
# Requires the Xcode command-line toolchain (swift build). No Xcode project file.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG=release
RUN=0
for arg in "$@"; do
    case "$arg" in
        --debug) CONFIG=debug ;;
        --run)   RUN=1 ;;
        *) echo "unknown arg: $arg" >&2; exit 1 ;;
    esac
done

APP="UsageTracker.app"
EXE_NAME="UsageTracker"

echo "==> swift build ($CONFIG)"
swift build -c "$CONFIG"
BIN_PATH="$(swift build -c "$CONFIG" --show-bin-path)/$EXE_NAME"

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_PATH" "$APP/Contents/MacOS/$EXE_NAME"
cp Info.plist "$APP/Contents/Info.plist"

# Bundle the `lut` CLI so the "Connect Claude Code" button can install + run it.
LUT_SRC="../dist/lut"
if [[ ! -x "$LUT_SRC" ]]; then
    echo "==> compiling lut binary"
    ( cd .. && ./scripts/build-cli.sh ) >/dev/null
fi
cp "$LUT_SRC" "$APP/Contents/Resources/lut"
chmod +x "$APP/Contents/Resources/lut"

# Ad-hoc sign so the Keychain + network entitlements work without a dev account.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || \
    echo "   (codesign skipped — app still runs locally)"

echo "==> built $(pwd)/$APP"

if [[ "$RUN" == "1" ]]; then
    echo "==> launching"
    open "$APP"
fi
