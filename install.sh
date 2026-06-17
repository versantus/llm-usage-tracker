#!/usr/bin/env bash
# LLM Usage Tracker — one-line installer (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/your-org/llm-usage-tracker/main/install.sh | bash
#
# Or, from a clone:   ./install.sh
#
# Installs the self-contained `lut` binary to ~/.local/bin, then runs
# `lut connect` to write your config and wire the Claude Code Stop hook.
# No bun/node needed at hook runtime — the binary embeds everything.
#
# Non-interactive (CI / scripted): set these before running and it won't prompt:
#   LUT_NAME, LUT_EMAIL, LUT_SERVER_URL, LUT_INGEST_TOKEN
#
# Overrides:
#   LUT_REPO        owner/repo to fetch from   (default: auto-detected / your-org/llm-usage-tracker)
#   LUT_BIN_DIR     install dir                 (default: ~/.local/bin)
#   LUT_NO_CONNECT  set to 1 to skip `lut connect`
set -euo pipefail

REPO_DEFAULT="your-org/llm-usage-tracker"
BIN_DIR="${LUT_BIN_DIR:-$HOME/.local/bin}"
DEST="$BIN_DIR/lut"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

os_arch() {
    local os arch
    case "$(uname -s)" in
        Darwin) os=darwin ;;
        Linux)  os=linux ;;
        *) die "unsupported OS: $(uname -s). Use install.ps1 on Windows." ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) arch=arm64 ;;
        x86_64|amd64)  arch=x64 ;;
        *) die "unsupported arch: $(uname -m)" ;;
    esac
    echo "$os-$arch"
}

# Figure out which GitHub repo to pull from: explicit override, else the origin
# remote of the clone we're running inside, else the placeholder default.
resolve_repo() {
    if [[ -n "${LUT_REPO:-}" ]]; then echo "$LUT_REPO"; return; fi
    if [[ -n "$SCRIPT_DIR" ]] && git -C "$SCRIPT_DIR" rev-parse >/dev/null 2>&1; then
        local url
        url="$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || true)"
        if [[ "$url" =~ github\.com[:/]+([^/]+/[^/.]+) ]]; then
            echo "${BASH_REMATCH[1]}"; return
        fi
    fi
    echo "$REPO_DEFAULT"
}

# Build the binary from a source tree using bun (installing bun if missing).
# $2 is the output path.
build_from_source() {
    local src="$1" out="$2"
    if ! command -v bun >/dev/null 2>&1; then
        say "installing bun (needed to build the binary)…"
        curl -fsSL https://bun.sh/install | bash >/dev/null
        export PATH="$HOME/.bun/bin:$PATH"
    fi
    command -v bun >/dev/null 2>&1 || die "bun not available after install"
    say "building lut binary with bun…"
    ( cd "$src" && bun build --compile --minify --sourcemap=none cli/lut.ts --outfile "$out" )
}

mkdir -p "$BIN_DIR"
REPO="$(resolve_repo)"

# Stage to a temp file, then atomically rename into place — overwriting a binary
# that a running watcher is executing would otherwise corrupt it (SIGKILL).
STAGE="$DEST.new.$$"
cleanup_stage() { rm -f "$STAGE"; }
trap cleanup_stage EXIT

# 1) Running from a clone with a prebuilt binary -> just copy it.
if [[ -n "$SCRIPT_DIR" && -x "$SCRIPT_DIR/dist/lut" ]]; then
    say "using prebuilt $SCRIPT_DIR/dist/lut"
    cp "$SCRIPT_DIR/dist/lut" "$STAGE"

# 2) Running from a clone with sources -> build it.
elif [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/cli/lut.ts" ]]; then
    build_from_source "$SCRIPT_DIR" "$STAGE"

# 3) Piped one-liner -> try a release asset, else clone + build.
else
    OSARCH="$(os_arch)"
    ASSET="lut-$OSARCH"
    URL="https://github.com/$REPO/releases/latest/download/$ASSET"
    say "downloading $ASSET from $REPO releases…"
    if curl -fsSL "$URL" -o "$STAGE" 2>/dev/null && [[ -s "$STAGE" ]]; then
        :
    else
        warn "no release asset (or download failed); cloning + building from source"
        TMP="$(mktemp -d)"
        trap 'rm -rf "$TMP"; cleanup_stage' EXIT
        git clone --depth 1 "https://github.com/$REPO.git" "$TMP/repo" >/dev/null 2>&1 \
            || die "could not clone https://github.com/$REPO (set LUT_REPO=owner/repo)"
        build_from_source "$TMP/repo" "$STAGE"
    fi
fi

chmod +x "$STAGE"
# Ad-hoc sign on macOS so the binary isn't killed by AMFI in edge cases.
if [[ "$(uname -s)" == "Darwin" ]] && command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$STAGE" >/dev/null 2>&1 || true
fi
mv -f "$STAGE" "$DEST"
say "installed $DEST"

# PATH hint
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on your PATH. Add to your shell profile:"
       printf '       export PATH="%s:$PATH"\n' "$BIN_DIR" >&2 ;;
esac

# 4) Connect: write config + wire the Claude Code hook.
if [[ "${LUT_NO_CONNECT:-}" == "1" ]]; then
    say "skipping connect (LUT_NO_CONNECT=1). Run: $DEST connect"
    exit 0
fi

ARGS=()
[[ -n "${LUT_NAME:-}" ]]         && ARGS+=(--name "$LUT_NAME")
[[ -n "${LUT_EMAIL:-}" ]]        && ARGS+=(--email "$LUT_EMAIL")
[[ -n "${LUT_SERVER_URL:-}" ]]   && ARGS+=(--server-url "$LUT_SERVER_URL")
[[ -n "${LUT_INGEST_TOKEN:-}" ]] && ARGS+=(--ingest-token "$LUT_INGEST_TOKEN")

say "connecting Claude Code…"
"$DEST" connect "${ARGS[@]}"

echo
say "All set. Run '$([[ "$DEST" == "$BIN_DIR/lut" ]] && echo lut || echo "$DEST") status' to verify."
