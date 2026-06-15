# AGENTS.md — llm-usage-tracker

Guidance for AI coding agents working in this repo. Keep it accurate; update it when
architecture, commands, or deployment change.

## What this is

Org-wide tracker for **LLM usage + carbon estimates**, by **user**, over **time**, with
**realtime reports**. Captures per-session token usage from Claude Code and Cowork,
computes carbon, and POSTs to a central server that serves a live dashboard + CLI report.

Modelled on CNaught's `carbonlog` plugin (`/path/to/carbonlog`) — the carbon
calculator and transcript parser are vendored from it — but rebuilt for **central,
multi-user** tracking with our own server instead of CNaught's cloud.

- **GitHub (private):** https://github.com/your-org/llm-usage-tracker
- **Production server (Fly.io, your-org org):** https://your-server.example.com

## Architecture

```
Claude Code ─ Stop hook ─┐
                         ├─→ POST /ingest ─→ SQLite ─→ /events (SSE) ─→ live dashboard
Cowork ─ watcher (poll) ─┘                         └─→ /api/* ───────→ cut report (CLI)
```

Three parts share a vendored core:

- **shared/** — dependency-free (no zod) so the client/hook path runs install-free.
  - `carbon-calculator.ts` — Jegham et al. energy/CO₂ model + per-model configs (Anthropic only; others approximate). `calculateSessionCarbon()`, `isCarbonApproximate()`, `formatCO2/formatEnergy`.
  - `transcript-parser.ts` — `parseTranscriptLines()` (assistant lines w/ `message.usage`, dedup by uuid) + `aggregate()`.
  - `types.ts` — `IngestEvent`, `SessionUsage`, `TokenUsageRecord`, `Provider`, `Surface`.
- **client/** — captures + posts.
  - `hooks/stop.ts` — Claude Code Stop hook entry (reads stdin via `hooks/stdin.ts`).
  - `sources/` — `source.ts` (interface + `toIngestEvent()`), `claude-code-source.ts`, `cowork-source.ts`. Pluggable; add new tools here.
  - `watch-cowork.ts` — long-running poller (Cowork has no hook surface).
  - `config.ts` — `~/.config/claude-usage-tracker/config.json`. `post.ts`/`spool.ts` — POST + offline spool. `setup.ts`, `wire-hook.ts`.
- **server/** — `index.ts` (`Bun.serve`: `/ingest`, `/events` SSE, `/api/*`, static dashboard), `db.ts` (SQLite, upsert by `(user_id, session_id)`, aggregations), `ingest.ts`, `schema.ts` (zod — **server only**), `sse.ts`, `public/` (vanilla JS + hand-rolled SVG charts).
- **cli/report.ts** — `cut report` terminal report.

## Key invariants (don't break these)

- **No double-counting:** the client always sends **absolute session totals** (full
  re-parse each Stop); the server upserts by `(user_id, session_id)`. Never switch to deltas.
- **Client/shared stay zero-dependency** (no zod, no imports needing `bun install`) so the
  plugin runs via `npx -y bun <file>.ts` with no install step. zod lives only in `server/`.
- **Hooks never throw** — `runHook()` wraps the body and exits 0 on error.
- **Carbon for non-Anthropic models is approximate** — flagged via `carbonApprox` /
  `isCarbonApproximate()`. Add per-model configs to `carbon-calculator.ts` to make exact.
- **Model breakdown** uses each session's `models_used` JSON (not just `primary_model`),
  allocating energy/CO₂ by token share — see `summaryByModel()` in `server/db.ts`.

## Commands

```bash
bun install                                   # deps (zod only)
bunx tsc --noEmit                             # typecheck (must stay clean)

LUT_ALLOW_NO_AUTH=1 bun run server/index.ts   # start server :4317 (auth is fail-closed; this runs it open for dev)
bun run client/setup.ts --name N --email E --server-url URL [--no-cowork] [--wire-hook]
bun run client/hooks/stop.ts                  # hook (reads stdin JSON)
bun run client/watch-cowork.ts [--once] [--interval 15]
bun run cli/report.ts [--days N] [--by user|model] [--json] [--server URL]
```

No test suite yet. Verify changes with `bunx tsc --noEmit` + a manual curl to `/ingest`
and a `cut report` (see README "Quick start").

## Config & data locations

- Client config: `~/.config/claude-usage-tracker/config.json` (`serverUrl`, identity, surfaces)
- Spool: `~/.config/claude-usage-tracker/spool.ndjson`
- Server DB: `~/.config/claude-usage-tracker/server.db` locally; `/data/server.db` on Fly (volume)
- Env overrides: `LUT_SERVER_URL`, `LUT_USER_EMAIL`, `LUT_PORT`, `LUT_DB_PATH`
- Auth (fail-closed — unset secrets return 503): `LUT_DASH_USER`/`LUT_DASH_PASS` (dashboard + `/api/*` Basic Auth),
  `LUT_INGEST_TOKEN` (clients send on `/ingest`), `LUT_ALLOW_NO_AUTH=1` (explicit local-dev open). `/api/health` always open.

## Deployment (Fly.io)

Hosted in the **your-org** org as app `llm-usage-tracker` (region `lhr`). SQLite persists
on a Fly **volume** mounted at `/data` (`LUT_DB_PATH=/data/server.db` in `fly.toml`).

```bash
flyctl deploy                                 # build Dockerfile + deploy
flyctl logs
flyctl status
```

- `Dockerfile` — `oven/bun:1.3.6-slim`, copies `package.json` (+ optional lockfile),
  `bun install`, copies source, runs `bun run server/index.ts`, healthcheck on `/api/health`.
- `fly.toml` — app name, `[[mounts]] source="data" destination="/data"`, `internal_port 4317`,
  `force_https`. **Keep `app` and `LUT_DB_PATH` in sync with this file when renaming.**
- First-time setup and team rollout details: see `DEPLOY.md`.

## Client install (team)

```
/plugin marketplace add https://github.com/your-org/llm-usage-tracker
/plugin install usage-tracker@<marketplace>
/usage-tracker:setup --server-url "https://your-server.example.com"
```

The plugin (`.claude-plugin/`, `hooks/hooks.json`, `commands/`) wires the Stop hook via
`${CLAUDE_PLUGIN_ROOT}` — robust across machines. For a local dev checkout instead, use
`bun run client/setup.ts --wire-hook` (merges an absolute path into `~/.claude/settings.json`;
**note:** that absolute path breaks if you rename/move the repo dir — re-run `--wire-hook`).

## Gotchas learned

- Renaming the repo dir breaks any `--wire-hook` absolute path in `~/.claude/settings.json`.
  The plugin path (`${CLAUDE_PLUGIN_ROOT}`) avoids this.
- A newly installed plugin's hooks need a Claude Code restart to activate.
- The marketplace `name` in `.claude-plugin/marketplace.json` must match what you install
  as `usage-tracker@<name>`; it can lag behind a repo rename (cached). 
- `bun.lock` (text) is the current lockfile; the Dockerfile copies `bun.lockb*` optionally so
  builds work with or without a binary lockfile.

## Extending to more tools

Add a `client/sources/<tool>-source.ts` implementing `Source.collectSession()` and set the
right `provider`/`surface`. Two kinds: **transcript/local** (parse files/DB — e.g. Codex CLI
`~/.codex/state_5.sqlite`, aggregate tokens only → carbon approximate) and **API-pull** (poll
a vendor admin API — Cursor/OpenAI/Google; needs credentials). See README "Surfaces &
extensibility".
