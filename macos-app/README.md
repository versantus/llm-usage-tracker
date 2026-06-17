# Usage Tracker — macOS app

A native SwiftUI desktop app that reads the LLM Usage Tracker stats and shows
them locally — no browser required. It lives in the **menu bar** (click the leaf
for a popover of headline totals + top users) and opens a **full dashboard
window** with charts and a per-user table. Both refresh live via the server's
SSE stream.

It's a thin read-only client over the same JSON API the web dashboard uses
(`/api/summary`, `/api/by-model`, `/api/over-time`, `/events`).

## Build

Requires the Xcode toolchain (`swift` on the path). No Xcode project file —
the build script compiles with Swift Package Manager and assembles a `.app`.

```bash
cd macos-app
./build.sh            # release build -> ./UsageTracker.app
./build.sh --run      # build, then launch
./build.sh --debug    # debug build
```

Then move `UsageTracker.app` to `/Applications` (or just double-click it).

> The build ad-hoc signs the app so it runs on the machine that built it. To
> distribute it to other Macs you'd sign + notarize with a Developer ID.

## Configure

The leaf icon appears in the menu bar. Click it → **Settings** (⌘,) and enter:

- **Server URL** — the same server the tracker reports to
  (e.g. `https://your-server.example.com`), or `http://localhost:4317` if you
  run the server on this machine.
- **Username / Password** — the dashboard Basic-Auth credentials
  (`LUT_DASH_USER` / `LUT_DASH_PASS` on the server). Leave blank only if the
  server runs with `LUT_ALLOW_NO_AUTH=1`.

The password is stored in the macOS **Keychain**; the URL and username in
`UserDefaults`. Hit **Test connection** to verify, then **Apply & reconnect**.

## How it works

- `MenuBarExtra` (window style) for the popover; a `Window` scene for the
  dashboard, opened on demand. `LSUIElement` keeps it out of the Dock.
- `DataStore` fetches the three aggregate endpoints in parallel, holds the
  `/events` SSE connection open to refresh on every new session, and falls back
  to a 60s poll if the stream drops.
- `Formatters.swift` mirrors `shared/carbon-calculator.ts` so numbers match the
  web dashboard exactly. Charts use Swift Charts.

## Layout

```
macos-app/
  Package.swift
  Info.plist                 # bundle metadata; LSUIElement + ATS exceptions
  build.sh                   # swift build + assemble UsageTracker.app
  Sources/UsageTracker/
    App.swift                # @main; scenes + AppDelegate (starts loading at launch)
    Settings.swift           # AppSettings + Keychain
    DataStore.swift          # API client + SSE + polling
    Models.swift             # Codable mirrors of the API JSON
    Formatters.swift         # number/equivalence formatting
    Theme.swift              # palette matching the web dashboard
    MenuBarView.swift        # popover
    DashboardView.swift      # full window: cards, charts, user table
    SettingsView.swift       # connection settings
```
