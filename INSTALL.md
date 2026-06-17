# Install

How to start reporting your **Claude Code** (and **Codex CLI**) usage to the
team's central usage + carbon dashboard. Pick one of the three ways below — the
first is the quickest.

> You only need this if you're a **user** reporting your own usage. Running the
> central server is a separate job — see [DEPLOY.md](./DEPLOY.md).

**You'll need:** the **server URL** and an **ingest token** from whoever runs the
server (e.g. `https://your-server.example.com`).

---

## Option A — one-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/your-org/llm-usage-tracker/main/install.sh | bash
```

It installs a tiny self-contained `lut` binary to `~/.local/bin`, asks who you
are + where to report, and then:

- **wires the Claude Code Stop hook** into `~/.claude/settings.json` (preserving
  any hooks you already have), and
- if **Codex CLI** is detected, enables a small background watcher for it too.

No bun/node is needed afterwards — the hook runs the binary directly.

Run it non-interactively (CI / dotfiles) by setting the values first:

```bash
LUT_NAME="Your Name" LUT_EMAIL=you@example.com \
LUT_SERVER_URL=https://your-server.example.com LUT_INGEST_TOKEN=<TOKEN> \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/your-org/llm-usage-tracker/main/install.sh)"
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/your-org/llm-usage-tracker/main/install.ps1 | iex
```

That's it. Verify with `lut status`.

---

## Option B — the desktop app

Prefer no terminal? The macOS app (see [macos-app/](./macos-app/)) reads the
dashboard locally **and** sets everything up for you:

1. Build/open `UsageTracker.app` (`cd macos-app && ./build.sh --run`), or install
   the released `.dmg`.
2. Click the menu-bar leaf → **Settings** (gear icon).
3. Fill in **Server URL**, your **name/email**, and the **ingest token**, then
   click **Connect Claude Code**.
4. If you use Codex, flip **Also track Codex CLI**.

The app bundles the same `lut` binary and runs it under the hood, so the result
is identical to Option A.

---

## Option C — the Claude Code plugin

The original path, if you'd rather manage it as a plugin:

```
/plugin marketplace add <your-org>/llm-usage-tracker
/plugin install usage-tracker@llm-usage-tracker
/usage-tracker:setup
```

The plugin wires the Stop hook via its `hooks/hooks.json`; `/usage-tracker:setup`
records your identity + server. (This path uses `npx -y bun` at hook time, so it
needs bun/node available.)

---

## Codex CLI & Cowork tracking

Codex and Cowork have no Stop-style hook, so each is tracked by a small
**watcher** that reads their local session logs and reports absolute token
totals (the server upserts, so nothing is double-counted):

- **Codex CLI** — `~/.codex/sessions/**/rollout-*.jsonl`. Carbon for OpenAI
  models is a rough estimate, flagged approximate.
- **Cowork** (Claude local agent mode) —
  `~/Library/Application Support/Claude/local-agent-mode-sessions/**/audit.jsonl`.

Options A and B enable these automatically when detected. To manage them by hand
(same commands for either surface):

```bash
lut codex  enable | disable | status
lut cowork enable | disable | status
lut scan-codex  [--hours N | --all]   # one-off backfill
lut scan-cowork                       # one-off backfill
```

`enable` installs a macOS LaunchAgent that runs the watcher at login. On
Linux/Windows there's no LaunchAgent — run `lut watch-codex` / `lut watch-cowork`
under your own service manager (systemd / Task Scheduler), or `lut scan-*` on a
schedule.

---

## Check it's working

```bash
lut status            # config, hook state, Codex state, server reachability
lut report --days 30  # quick usage + carbon summary
```

Or open the server URL in a browser (dashboard login required) — your name
appears in the Users table after your next session ends.

## Managing / uninstalling

```bash
lut unwire            # remove the Claude Code Stop hook
lut codex disable     # remove the Codex watcher
rm ~/.local/bin/lut   # remove the binary
```

Config lives at `~/.config/llm-usage-tracker/config.json`.

---

## Privacy & data

Only **token counts, model names, timestamps, and your name/email** are sent — no
prompts, code, or file contents ever leave your machine. If the server is
unreachable, events are spooled locally and retried later.
