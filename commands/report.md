# /usage-tracker:report

Show a usage + carbon report from the central server.

## Instructions

Run the report script and show its output to the user verbatim (it is already formatted as a plain-text table). Default to a by-user report for the last 30 days unless the user asks otherwise (e.g. "by model", "all time", "last 7 days").

```bash
npx -y bun ${CLAUDE_PLUGIN_ROOT}/cli/report.ts --days 30 --by user
```

Options you can adjust based on the user's request:
- `--by model` — break down by model instead of user
- `--days N` — change the window (omit or `--days 0` for all time)
- `--server <URL>` — point at a non-default server

If the script reports it can't reach the server, tell the user to start it with `bun run ${CLAUDE_PLUGIN_ROOT}/server/index.ts` (or open the live dashboard — see `/usage-tracker:dashboard`).
