# AI Carbon Tracker — Windows tray GUI

The Windows settings GUI + system-tray icon is **built into `lut.exe`** — no
separate app to install. Just run:

```
lut gui
```

That launches a tray icon with a **Settings** window (server URL / name / email /
ingest token + per-tool toggles), plus **Open dashboard**, **Status**, and
**Quit**. The installer (`install.ps1`) offers to run it at login for you.

## How it works

`UsageTracker.ps1` in this folder is the tray UI (PowerShell + WinForms). It's
**compiled into the `lut` binary** as embedded text (see `client/gui.ts`), and
`lut gui` runs it hidden via `powershell -EncodedCommand` — so there's one
self-contained `lut.exe`, nothing extra to ship.

The script shells back to `lut` for the actual work:
- **Claude Code** → Stop hook in `~/.claude/settings.json` (wired by `lut connect`).
- **Codex / Gemini-Antigravity / Copilot / Ollama** → the tray supervises a
  `lut watch-<tool>` process for each tool you tick (Windows has no LaunchAgents).
- **Cowork** is macOS-only and isn't tracked on Windows.

> `UsageTracker.ps1` is the *source* for the embedded GUI — editing it changes
> what `lut gui` runs after the next build. Authored on macOS; needs a Windows
> smoke test.
