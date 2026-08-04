# /usage-tracker:dashboard

Start (if needed) and open the live realtime dashboard.

## Instructions

1. Check whether the server is already running:

```bash
curl -s http://localhost:4317/api/health
```

2. If that fails, start the server in the background (so it survives this shell):

```bash
nohup bun run "${CLAUDE_PLUGIN_ROOT}/server/index.ts" > /tmp/usage-tracker-server.log 2>&1 &
```

(On Windows use `Start-Process bun -ArgumentList 'run',"$env:CLAUDE_PLUGIN_ROOT/server/index.ts" -WindowStyle Hidden` instead.)

3. Tell the user the dashboard is at **http://localhost:4317/** and open it for them with the platform's opener — `open` (macOS), `xdg-open` (Linux), or `start` (Windows):

```bash
open http://localhost:4317/
```

The dashboard shows totals, per-user usage + CO₂, a CO₂-by-user-over-time chart, and a tokens-by-model chart. It updates live (via Server-Sent Events) as sessions complete.
