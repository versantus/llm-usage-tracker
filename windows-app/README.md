# AI Carbon Tracker — Windows tray app

A lightweight system-tray app (PowerShell + WinForms) that gives Windows a
**settings screen** and a **tray icon**, mirroring the macOS app. It wraps the
`lut.exe` CLI and keeps the background watchers running.

> macOS has the native `UsageTracker.app`; this is the Windows equivalent.
> It needs **`lut.exe` installed first** (see the repo's `install.ps1`).

## Install

1. Install the CLI if you haven't:
   ```powershell
   irm https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/install.ps1 | iex
   ```
2. Install the tray app (copies it in, adds Start-Menu + optional Startup shortcut, and launches it):
   ```powershell
   irm https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/windows-app/install-tray.ps1 | iex
   ```

A leaf-style icon appears in the system tray (bottom-right, may be under the `^`
overflow). **Right-click it → Settings…**

## Use

- **Settings…** — enter Server URL, your name/email, and the Ingest token (from
  1Password), tick which tools to track, then **Save & Connect**. This runs
  `lut connect` (writes config + wires the Claude Code Stop hook) and starts the
  watchers for the tools you ticked.
- **Open dashboard** — opens the dashboard URL in your browser.
- **Status** — shows `lut status` (config, hook, server reachability).
- **Quit** — stops the tray app and its watchers.

## How it works

Claude Code is tracked by a **Stop hook** in `~/.claude/settings.json` (wired by
`lut connect`). Codex / Gemini-Antigravity / Copilot / Ollama have no hook, so
the tray app runs a `lut watch-<tool>` background process for each ticked tool
and restarts any that exit (the Windows equivalent of the macOS LaunchAgents).
Cowork is macOS-only and isn't tracked on Windows.

## Files

- `UsageTracker.ps1` — the tray app (icon, settings form, watcher supervisor).
- `UsageTracker.vbs` — launches it with no console window.
- `install-tray.ps1` — installer (copy + shortcuts + launch).

> Authored on macOS and not yet run on Windows — please report any issues.
