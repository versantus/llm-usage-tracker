# llm-usage-tracker

Centrally track Claude (and other AI tool) **usage and carbon estimates** across your
team — by **user**, over **time** — with **realtime reports**.

A small Bun + TypeScript system in three parts:

| Part | What it does |
|------|--------------|
| **client** | A Claude Code plugin (Stop hook) + Cowork watcher. Parses each session's transcript, computes carbon, and POSTs absolute totals to the server tagged with your identity. |
| **server** | Local `Bun.serve` ingest endpoint + SQLite store + Server-Sent Events + a live dashboard. |
| **cli** | `cut report` — a terminal usage/carbon report. |

Carbon math is the Jegham et al. methodology (arXiv 2505.09598), vendored from
CNaught's [carbonlog](https://github.com/CNaught-Inc/claude-code-plugins). Only
Anthropic models have validated configs; other providers are flagged **approximate**.

## How it works

```
Claude Code ─ Stop hook ─┐
                         ├─→ POST /ingest ─→ SQLite ─→ /events (SSE) ─→ live dashboard
Cowork ─ watcher (poll) ─┘                         └─→ /api/* ───────→ cut report (CLI)
```

The client always sends **absolute session totals**; the server upserts by
`(user_id, session_id)`, so re-sends of a growing session overwrite rather than
double-count.

## Quick start (local)

```bash
bun install

# 1. Start the central server (http://localhost:4317)
#    Auth is fail-closed: locally, run it open with LUT_ALLOW_NO_AUTH=1.
LUT_ALLOW_NO_AUTH=1 bun run server/index.ts

# 2. Configure this machine (identity + server URL)
bun run client/setup.ts --name "You" --email you@example.com

# 3a. Claude Code: install as a plugin (no remote repo needed for testing)
#     In Claude Code:
#       /plugin marketplace add /path/to/llm-usage-tracker
#       /plugin install usage-tracker@llm-usage-tracker
#     The Stop hook then reports every session automatically.

# 3b. Cowork: run the watcher (Cowork has no hook surface)
bun run client/watch-cowork.ts

# 4. Reports
open http://localhost:4317/        # live dashboard
bun run cli/report.ts --days 30    # CLI report (--by model, --days N, --json)
```

## Slash commands (plugin)

- `/usage-tracker:setup` — configure identity + server
- `/usage-tracker:report` — show the usage/carbon report
- `/usage-tracker:dashboard` — start + open the live dashboard

## Surfaces & extensibility

Sources are pluggable. Two kinds:

- **Transcript/local** (parse on-disk per-session data — no credentials):
  - ✅ **Claude Code** — full token breakdown (`~/.claude/projects/.../*.jsonl`)
  - ✅ **Cowork** — same shape (`~/Library/Application Support/Claude/local-agent-mode-sessions/.../audit.jsonl`)
  - 🔜 **Codex CLI** — `~/.codex/state_5.sqlite` (aggregate tokens only → carbon approximate)
- **API-pull** (poll a vendor admin API — needs credentials) — *future*:
  - **Cursor** (Admin API), **ChatGPT** (OpenAI usage API), **Gemini** (OTEL/API)

Non-Anthropic carbon needs per-model power/throughput configs added to
`shared/carbon-calculator.ts`; until then those rows show tokens with carbon
marked approximate.

## Config & data locations

- Client config: `~/.config/llm-usage-tracker/config.json`
- Offline spool: `~/.config/llm-usage-tracker/spool.ndjson`
- Server DB: `~/.config/llm-usage-tracker/server.db` (override `LUT_DB_PATH`)

> Upgrading from an older `claude-usage-tracker` install? The config dir moved —
> re-run `/usage-tracker:setup` (or `mv ~/.config/claude-usage-tracker ~/.config/llm-usage-tracker`).
- Env: `LUT_SERVER_URL`, `LUT_USER_EMAIL`, `LUT_PORT`
- Auth (fail-closed): `LUT_DASH_USER`/`LUT_DASH_PASS` (dashboard + API), `LUT_INGEST_TOKEN`
  (clients), or `LUT_ALLOW_NO_AUTH=1` to run open locally. See [DEPLOY.md](./DEPLOY.md).

Carbon & energy use the Jegham et al. method; **water** is derived from energy
(on-site cooling + off-site generation, ~1.8 L/kWh) and is approximate &
region-dependent — tune the factors in `shared/carbon-calculator.ts`.

## Deferred (kept simple for v1)

No auth / multi-tenant (LAN-local, trusts client identity), no history backfill,
single schema migration. See the plan for the roadmap.
