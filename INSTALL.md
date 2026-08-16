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
curl -fsSL https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/install.sh | bash
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
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/install.sh)"
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/install.ps1 | iex
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

**Windows** has an equivalent tray GUI **built into `lut.exe`** (settings window +
system-tray icon) — just run `lut gui` (the installer offers to start it at
login). See [windows-app/](./windows-app/).

---

## Option C — the Claude Code plugin

The original path, if you'd rather manage it as a plugin:

```
/plugin marketplace add versantus/llm-usage-tracker
/plugin install usage-tracker@llm-usage-tracker
/usage-tracker:setup
```

The plugin wires the Stop hook via its `hooks/hooks.json`; `/usage-tracker:setup`
records your identity + server. (This path uses `npx -y bun` at hook time, so it
needs bun/node available.)

---

## Tracking other tools (no hook)

Tools without a Stop-style hook are tracked by small **watchers** that read their
local session data and report absolute totals (the server upserts, so nothing is
double-counted). Supported surfaces:

| Surface | Reads | Notes |
|---------|-------|-------|
| `codex`   | `~/.codex/sessions/**/rollout-*.jsonl` | OpenAI carbon ≈ approximate |
| `cowork`  | `…/Claude/local-agent-mode-sessions/**/audit.jsonl` | Claude local agent mode |
| `copilot` | `~/.copilot/session-state/*` + VS Code `GitHub.copilot-chat/transcripts` | output often estimated |
| `gemini`  | OTLP telemetry log (enabled in `~/.gemini/settings.json`) | needs telemetry on |
| `ollama`  | desktop app `db.sqlite` | **desktop only** — CLI isn't logged |

Options A and B enable every detected surface automatically. To manage by hand
(same verbs for any surface):

```bash
lut codex   enable | disable | status
lut copilot enable | disable | status
lut gemini  enable | disable | status   # also turns on Gemini telemetry
lut ollama  enable | disable | status
lut scan-<surface> [--hours N | --all]  # one-off backfill
lut status                              # state of every surface
```

`enable` installs a macOS LaunchAgent that runs the watcher at login. On
Linux/Windows there's no LaunchAgent — run `lut watch-<surface>` under your own
service manager (systemd / Task Scheduler), or `lut scan-<surface>` on a schedule.

Carbon for all of these is **approximate** (no validated energy config; Ollama
runs on local hardware so its figure is especially rough).

### Cursor (server-side)

Cursor keeps usage on its servers, so there's no local watcher. A team admin
pulls it via the Admin API and ingests it — best run on the server host on a
schedule, not per laptop:

```bash
CURSOR_API_KEY=key_... lut cursor-pull --days 30
```

> The `copilot` / `gemini` / `ollama` / `cursor` surfaces need a server built
> from this version (older servers reject unknown surfaces). Redeploy the server
> after upgrading.

---

## Check it's working

```bash
lut status            # config, hook state, Codex state, server reachability
lut report --days 30  # quick usage + carbon summary
```

Or open the server URL in a browser (dashboard login required) — your name
appears in the Users table after your next session ends.

## Staying up to date

```bash
lut update --check    # is there a newer release?
lut update            # install it
```

The tracker checks once a day on its own and **only ever tells you** — it never
installs in the background, because an update re-signs the binary and rewrites
the background watchers, which can make macOS re-ask for permissions.

You'll see the notice in whichever surface you use:

- **Desktop app** — Settings → *Software update*, with a button that updates
  both the app and the helper. A daily check runs in the background; the menu
  bar popover shows a banner when something's waiting.
- **Windows tray** — right-click → *Check for updates*, plus a balloon tip.
- **Terminal** — `lut status` prints the available version.
- **Dashboard** — the Users table flags anyone on an older tracker, so whoever
  runs the server can see the rollout at a glance.

## Linux

`install.sh` works the same way. Watchers run as a **systemd user unit**
(`llm-usage-tracker-watchers.service`), set up automatically by `lut connect`.
User units stop at logout unless lingering is enabled:

```bash
sudo loginctl enable-linger $USER
systemctl --user status llm-usage-tracker-watchers
```

With no systemd user session, run `lut watch-all` under whatever supervises
services on that box.

## Managing / uninstalling

```bash
lut unwire            # remove the Claude Code Stop hook
lut codex disable     # stop tracking one tool (the others keep running)
rm ~/.local/bin/lut   # remove the binary
```

All enabled watchers share a single background process. `lut status` shows it.

Config lives at `~/.config/llm-usage-tracker/config.json`.

---

## Privacy & data

Only **token counts, model names, timestamps, a work-type label
(e.g. "coding" / "research"), and your name/email** are sent — no prompts,
code, or file contents ever leave your machine. If the server is unreachable,
events are spooled locally and retried later.

The work-type label is computed **on your machine** from metadata only (tool
counts, file extensions, command kinds — never text). Turn it off any time
with `lut connect --no-category`; your sessions then report `unknown`. See the
README's "Work-type categories" section for the full mechanics.
