# LLM Usage Tracker

See how much your team uses Claude (and other AI tools) — tokens, energy,
carbon and water estimates, per person, live on one dashboard. 🌱

**Nothing sensitive ever leaves your machine.** Only token counts, model names,
timestamps and your name/email are sent. Never your prompts, code, or files.

---

## Join in (2 minutes, one command)

You need two things from whoever runs your team's dashboard:
the **server URL** and an **ingest token**. Then:

**Mac / Linux** — open the Terminal app, paste this, press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/install.sh | bash
```

**Windows** — open PowerShell, paste this, press Enter:

```powershell
irm https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/install.ps1 | iex
```

The installer asks for your **name**, **work email**, the **server URL** and
the **token** — type them in when prompted. That's the whole setup:

- Your Claude Code sessions report automatically from now on.
- Other AI tools on your machine (Codex, Cowork, Copilot, Gemini, Ollama
  desktop) are detected and tracked automatically too.
- On Windows you also get a little tray icon with a settings window.

Your details are saved privately on **your** machine
(`~/.config/llm-usage-tracker/config.json`) — the token never goes anywhere
near git or the repo, so there's nothing secret to accidentally publish.

**Check it worked:** run `lut status`. After your next Claude session ends,
your name appears on the dashboard.

Prefer an app over a terminal? There's a **macOS menu-bar app** and a
**Windows tray app** that do the same setup with clicks — see
[INSTALL.md](./INSTALL.md) for those and for per-tool details.

---

## What you get

Open the server URL in your browser: live totals, per-user and per-model
breakdowns, CO₂ over time, and fun equivalents (cups of tea boiled ☕). It
updates in realtime as sessions finish.

Or in the terminal:

```bash
lut report --days 30
lut report --days 30 --by category   # what KINDS of work AI is doing
```

## Work-type categories (and how they stay private)

Each session is labelled with the kind of work it was: **coding · debugging ·
docs-writing · research · planning · other** — so the team can see whether AI
is being used for the right tasks.

How it works without leaking anything:

1. On your machine, the tracker reduces each session to a **numeric feature
   vector** — counts of tool types used, file *extensions* edited, kinds of
   commands run, plan-mode markers, lines-changed totals. No prompt text, code,
   file names, or commands are in it.
2. A deterministic scorer picks the category. Only if the call is too close
   does it (optionally) ask Claude — showing it **only that numeric vector**,
   never session content — via your own `claude` CLI, locally. No `claude`
   installed → this step is silently skipped.
3. The **only** categorisation data sent to the team server is three fields:
   the category label, a confidence number, and which stage produced it.

Opting out: `lut connect --no-category` (or `"categories": false` in your
config) — your sessions then report `unknown`, including past ones on the next
re-scan. To keep categories but never invoke the LLM step:
`--no-llm-classify`.

Backfilling old sessions: `lut scan-claude-code --all` (and
`lut scan-cowork --all`) re-reports history with categories added — safe to
run any time, nothing is double-counted.

---

## For the person running the server

One small service; teammates' machines POST their totals to it. Run it
anywhere (we use [Fly.io](https://fly.io) — free tier is fine):

```bash
LUT_DASH_PASS=pick-a-password LUT_INGEST_TOKEN=pick-a-secret bun run server/index.ts
```

Auth is **fail-closed**: with no secrets set, the server denies everything
(so forgetting to configure it can never leak data). Secrets live in env vars
only — nothing goes in git; `.env.local` is gitignored, and
[.env.local.sample](./.env.local.sample) shows the shape. Full deployment
guide (Fly.io, Docker, tokens): [DEPLOY.md](./DEPLOY.md).

Hand teammates the server URL + the ingest token, point them at the install
command above, and you're done.

---

## For developers

A small Bun + TypeScript system in three parts:

| Part | What it does |
|------|--------------|
| **client** | Claude Code Stop hook + per-tool watchers. Parses local session data, computes carbon, POSTs absolute totals tagged with your identity. |
| **server** | `Bun.serve` ingest endpoint + SQLite + Server-Sent Events + the live dashboard. |
| **cli** | The `lut` binary (installer builds/downloads it): connect, status, report, watchers. |

```
Claude Code ─ Stop hook ──┐
                          ├─→ POST /ingest ─→ SQLite ─→ /events (SSE) ─→ live dashboard
other tools ─ watchers  ──┘                        └──→ /api/* ───────→ lut report
```

The client always sends **absolute session totals**; the server upserts by
`(user_id, session_id)`, so re-sends of a growing session overwrite rather
than double-count — retries and duplicates are harmless by design.

### Local dev quick start

```bash
bun install

# 1. Server, running open locally (auth is fail-closed otherwise)
LUT_ALLOW_NO_AUTH=1 bun run server/index.ts     # http://localhost:4317

# 2. Configure this machine + wire the Claude Code hook
bun cli/lut.ts connect --name "You" --email you@example.com

# 3. Reports
open http://localhost:4317/                     # live dashboard
bun cli/lut.ts report --days 30
```

You can also install it as a Claude Code plugin
(`/plugin marketplace add versantus/llm-usage-tracker`) — see
[INSTALL.md](./INSTALL.md), Option C.

### Tracked surfaces & extensibility

Sources are pluggable (`client/sources/`). Local/transcript sources need no
credentials: **Claude Code**, **Cowork**, **Codex CLI**, **Copilot**,
**Gemini CLI** (via telemetry), **Ollama desktop**. **Cursor** is pulled
server-side via its Admin API (`lut cursor-pull`). Details + how to add more:
[docs/tracking-more-tools.md](./docs/tracking-more-tools.md).

### Carbon methodology

Carbon and energy use the Jegham et al. methodology (arXiv 2505.09598),
vendored from CNaught's [carbonlog](https://github.com/CNaught-Inc/claude-code-plugins).
Only Anthropic models have validated configs; other providers are flagged
**approximate**. Water is derived from energy (~1.8 L/kWh, on-site cooling +
off-site generation) and is region-dependent — tune the factors in
`shared/carbon-calculator.ts`.

### Config & data locations

- Client config: `~/.config/llm-usage-tracker/config.json`
- Offline spool (server unreachable → events queue + retry): `~/.config/llm-usage-tracker/spool.ndjson`
- Server DB: `~/.config/llm-usage-tracker/server.db` (override `LUT_DB_PATH`)
- Env overrides: `LUT_SERVER_URL`, `LUT_USER_EMAIL`, `LUT_PORT`
- Auth (fail-closed): `LUT_DASH_USER`/`LUT_DASH_PASS` (dashboard + API),
  `LUT_INGEST_TOKEN` (clients), or `LUT_ALLOW_NO_AUTH=1` for local dev

### Uninstall

```bash
lut unwire            # remove the Claude Code hook
lut <surface> disable # remove a watcher (codex/cowork/copilot/gemini/ollama)
rm ~/.local/bin/lut   # remove the binary
```
