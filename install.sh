#!/usr/bin/env bash
# LLM Usage Tracker — one-line installer (macOS / Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/install.sh | bash
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
#   LUT_REPO        owner/repo to fetch from   (default: auto-detected / versantus/llm-usage-tracker)
#   LUT_REF         branch or tag to build from source instead of the latest
#                   release / local checkout (for testing a fix before it ships)
#   LUT_BIN_DIR     install dir                 (default: ~/.local/bin)
#   LUT_NO_CONNECT  set to 1 to skip `lut connect`
set -euo pipefail

REPO_DEFAULT="versantus/llm-usage-tracker"
BIN_DIR="${LUT_BIN_DIR:-$HOME/.local/bin}"
DEST="$BIN_DIR/lut"
# Only trust BASH_SOURCE when it's a real file: when piped (`curl | bash`) it's
# unset and falling back to $0 ("bash") would wrongly treat the CURRENT
# DIRECTORY as a checkout of this repo.
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

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

# Clone the repo (optionally at a ref) into a temp dir and build from it. $1 is
# the output path; $2 (optional) is the branch/tag.
clone_and_build() {
    local out="$1" ref="${2:-}"
    local args=(--depth 1)
    [[ -n "$ref" ]] && args+=(--branch "$ref")
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"; cleanup_stage' EXIT
    if ! git clone "${args[@]}" "https://github.com/$REPO.git" "$TMP/repo" >/dev/null 2>&1; then
        [[ -n "$ref" ]] && die "could not clone $REPO at ref '$ref' (needs git + network; branch/tag names only)"
        die "could not clone https://github.com/$REPO (set LUT_REPO=owner/repo)"
    fi
    build_from_source "$TMP/repo" "$out"
}

# 0) Naming a ref means "install THAT code" — it wins over local checkouts and
#    release assets alike, so testers never silently get the wrong build.
if [[ -n "${LUT_REF:-}" ]]; then
    say "building $REPO@$LUT_REF from source…"
    clone_and_build "$STAGE" "$LUT_REF"

# 1) Running from a clone with a prebuilt binary -> just copy it.
elif [[ -n "$SCRIPT_DIR" && -x "$SCRIPT_DIR/dist/lut" ]]; then
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
        clone_and_build "$STAGE"
    fi
fi

chmod +x "$STAGE"
# Ad-hoc sign on macOS so the binary isn't killed by AMFI in edge cases.
# `-i lut` pins the signing identifier: codesign otherwise derives it from the
# staging filename ("lut.new.$$"), giving every install a different code
# identity, so macOS TCC treats each upgrade as a brand-new app and re-asks for
# every permission the user already granted.
if [[ "$(uname -s)" == "Darwin" ]] && command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - --identifier lut "$STAGE" >/dev/null 2>&1 || true
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

# ${ARGS[@]+...}: bash 3.2 (stock macOS) treats an empty array as unbound
# under `set -u`, so a plain "${ARGS[@]}" would abort the installer here.
# A connect failure (e.g. output redirected so prompts are disabled) must NOT
# abort the install — the binary is already in place; tell the user how to
# finish instead of dying under `set -e`.
say "connecting Claude Code…"
connect_hint() { warn "setup incomplete — finish by running: lut connect"; }
if [[ -n "${LUT_NAME:-}" && -n "${LUT_EMAIL:-}" ]]; then
    # Fully specified via env (CI / dotfiles): no prompts needed.
    "$DEST" connect ${ARGS[@]+"${ARGS[@]}"} || connect_hint
elif [[ -t 0 ]]; then
    "$DEST" connect ${ARGS[@]+"${ARGS[@]}"} || connect_hint
elif (exec </dev/tty) 2>/dev/null; then
    # Piped one-liner: stdin is the script itself, so reattach prompts to the
    # terminal — otherwise `lut connect` can never ask for name/email.
    "$DEST" connect ${ARGS[@]+"${ARGS[@]}"} </dev/tty || connect_hint
else
    warn "no interactive terminal — finish setup by running: lut connect"
    exit 0
fi

echo
say "All set. Run '$([[ "$DEST" == "$BIN_DIR/lut" ]] && echo lut || echo "$DEST") status' to verify."
