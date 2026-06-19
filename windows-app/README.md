# AI Carbon Tracker — Windows tray GUI

The Windows settings GUI + system-tray icon is **built into `lut.exe`** — no
separate app, **no terminal needed**.

## Easiest: double-click

1. Download **`lut-windows-x64.exe`** from the
   [latest release](https://github.com/versantus/llm-usage-tracker/releases/latest)
   and save it somewhere permanent (e.g. a `lut` folder). Optionally rename it to
   `lut.exe`.
2. **Double-click it.** A tray icon appears (bottom-right) and a **Settings**
   window opens — fill in **Server URL / name / email / ingest token** (from
   1Password), tick the tools to track, click **Save & Connect**. Done.

Double-clicking also sets it to **start automatically at login** (a launcher is
added to your Startup folder) and adds a Start-Menu entry.

The tray menu has **Settings**, **Open dashboard**, **Status**, and **Quit**.
(From a terminal you can also run `lut gui` directly.)

## How it works

`UsageTracker.ps1` in this folder is the tray UI (PowerShell + WinForms). It's
**compiled into the `lut` binary** as embedded text (see `client/gui.ts`), and
`lut gui` runs it hidden via `powershell -EncodedCommand` — so there's one
self-contained `lut.exe`, nothing extra to ship.

The script shells back to `lut` for the actual work:
- **Claude Code** → Stop hook in `~/.claude/settings.json` (wired by `lut connect`).
- **Codex / Cowork / Gemini-Antigravity / Copilot / Ollama** → the tray supervises
  a `lut watch-<tool>` process for each tool you tick (Windows has no LaunchAgents).
  Cowork reads `%APPDATA%\Claude\local-agent-mode-sessions`.

Watcher output is logged to `%LOCALAPPDATA%\llm-usage-tracker\logs\<tool>.log` —
check there (or the spool at `~/.config/llm-usage-tracker/spool.ndjson`) if a tool
isn't coming through.

> `UsageTracker.ps1` is the *source* for the embedded GUI — editing it changes
> what `lut gui` runs after the next build. Authored on macOS; needs a Windows
> smoke test.
