#!/usr/bin/env bash
# Build UsageTracker.app — a native SwiftUI menu-bar + dashboard app.
#
#   ./build.sh                    # release build for this Mac -> ./UsageTracker.app
#   ./build.sh --debug            # debug build
#   ./build.sh --run              # build then launch
#   ./build.sh --arch x86_64      # cross-build for Intel (CI publishes both)
#   ./build.sh --zip              # also produce UsageTracker-macos-<arch>.zip
#
# The bundle version is stamped from shared/version.ts, so the app and the `lut`
# helper always report the same number and the update checker can compare either
# against one release tag.
#
# Requires the Xcode command-line toolchain (swift build). No Xcode project file.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG=release
RUN=0
ZIP=0
ARCH="$(uname -m)"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --debug)  CONFIG=debug ;;
        --run)    RUN=1 ;;
        --zip)    ZIP=1 ;;
        --arch)   shift; ARCH="${1:-}" ;;
        --arch=*) ARCH="${1#*=}" ;;
        *) echo "unknown arg: $1" >&2; exit 1 ;;
    esac
    shift
done
case "$ARCH" in
    arm64)  LUT_ASSET=lut-darwin-arm64 ;;
    x86_64) LUT_ASSET=lut-darwin-x64 ;;
    *) echo "unsupported --arch: $ARCH (expected arm64 or x86_64)" >&2; exit 1 ;;
esac

APP="UsageTracker.app"
EXE_NAME="UsageTracker"

# Single source of truth for the version (shared/version.ts).
VERSION="$(sed -n "s/^export const CLIENT_VERSION = '\([^']*\)'.*/\1/p" ../shared/version.ts)"
if [[ -z "$VERSION" ]]; then
    echo "could not read CLIENT_VERSION from ../shared/version.ts" >&2
    exit 1
fi
echo "==> version $VERSION ($ARCH)"

echo "==> swift build ($CONFIG, $ARCH)"
swift build -c "$CONFIG" --arch "$ARCH"
BIN_PATH="$(swift build -c "$CONFIG" --arch "$ARCH" --show-bin-path)/$EXE_NAME"

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_PATH" "$APP/Contents/MacOS/$EXE_NAME"
cp Info.plist "$APP/Contents/Info.plist"

# Stamp the version into the copy (Info.plist in git keeps a placeholder).
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$APP/Contents/Info.plist"

# Bundle the `lut` CLI so the "Connect Claude Code" button can install + run it.
# Must match the app's architecture — the app runs it as a subprocess.
#
# Always recompiled: reusing whatever happens to be in dist/ silently ships a
# stale helper (and the app hands that copy to ~/.local/bin), which is exactly
# the kind of version skew the update checker exists to prevent. It takes well
# under a second.
echo "==> compiling $LUT_ASSET"
( cd .. && ./scripts/build-cli.sh "darwin-${ARCH/x86_64/x64}" ) >/dev/null
LUT_SRC="../dist/$LUT_ASSET"
cp "$LUT_SRC" "$APP/Contents/Resources/lut"
chmod +x "$APP/Contents/Resources/lut"

# Ad-hoc sign so the Keychain + network entitlements work without a dev account.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || \
    echo "   (codesign skipped — app still runs locally)"

echo "==> built $(pwd)/$APP"

if [[ "$ZIP" == "1" ]]; then
    # Asset names the in-app updater looks for (see Updater.appAssetName).
    case "$ARCH" in
        arm64)  ZIP_NAME="UsageTracker-macos-arm64.zip" ;;
        x86_64) ZIP_NAME="UsageTracker-macos-x64.zip" ;;
    esac
    rm -f "$ZIP_NAME"
    # ditto preserves the bundle structure and signature; `zip -r` does not.
    ditto -c -k --keepParent "$APP" "$ZIP_NAME"
    echo "==> packaged $(pwd)/$ZIP_NAME"
fi

if [[ "$RUN" == "1" ]]; then
    echo "==> launching"
    open "$APP"
fi
