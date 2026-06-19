# Tracking more tools: Gemini, Copilot, Ollama, Cursor

How the tracker covers tools beyond Claude Code / Codex / Cowork. Based on what
each writes to disk and on how
[Agent Cat's connectors](https://github.com/yong076/agentcat-connectors) do it
(its collector was read directly at `~/.agentcat/connectors/bin/agentcat`).

| Tool | Local data? | Source | Status |
|------|-------------|--------|--------|
| **Gemini CLI** | Only with telemetry on | OTLP telemetry log | ✅ implemented, fixture-verified |
| **GitHub Copilot** | Yes (partial) | CLI logs + VS Code transcripts | ✅ implemented, fixture-verified |
| **Ollama (desktop)** | Yes | desktop `db.sqlite` | ✅ implemented, verified on real db |
| **Ollama (CLI)** | **No** | — | ❌ not locally recoverable |
| **Cursor** | **No** | Admin API (server-side) | ⚠️ implemented, unverified (needs team key) |

All carbon for these is **approximate** — none has a validated energy config, and
output tokens are often char-estimated (Copilot/Ollama) rather than measured.
The new surfaces (`gemini-cli`, `copilot`, `ollama`) and provider `cursor` are in
`shared/types.ts` + the server's ingest `schema.ts`, so **the server must be
redeployed** before it will accept them (older servers 400 unknown surfaces).

---

## Gemini CLI — `client/sources/gemini-source.ts`

Gemini doesn't persist tokens in its session logs, but emits OpenTelemetry. We
read whatever `telemetry.outfile` is configured in `~/.gemini/settings.json`
(co-existing with Agent Cat instead of fighting over the single outfile), and sum
the **`gemini_cli.token.usage`** metric (fallback `gen_ai.client.token.usage`),
grouped by `session.id`. Token classes (input/output/cache/thought) come from the
data-point attributes; it's a cumulative counter so we take the max per class.

`lut gemini enable` turns on local telemetry (writes the `telemetry` block to
`~/.gemini/settings.json`, defaulting `outfile` to
`~/.config/llm-usage-tracker/gemini-telemetry.log`) and starts the watcher.

**Antigravity CLI** (Google's successor to gemini-cli, which it replaces) shares
the same `~/.gemini` config and OTEL telemetry, so it's tracked by the *same
opt-in* — no separate surface. The parser also accepts an
`antigravity_cli.token.usage` vendor metric in case it's renamed; the standard
`gen_ai.client.token.usage` is handled regardless.

Verified against a synthetic OTLP fixture (cumulative max + reasoning folded into
output). On this machine the live log is still empty (Gemini hasn't run since
telemetry was enabled), so end-to-end with real Gemini data is still pending.

## GitHub Copilot — `client/sources/copilot-source.ts`

Two local sources: the CLI's `~/.copilot/session-state/<hash>/events.jsonl` and
VS Code's `<workspaceStorage>/<hash>/GitHub.copilot-chat/transcripts/*.jsonl`
(`session.start` with `producer:copilot-agent`). Output tokens come from
`data.outputTokens` when present, else a char/4 estimate of the content;
`reasoningText` adds reasoning. Model is inferred from `data.model` / tool-call-id
prefixes. One file = one session.

Verified against a synthetic transcript fixture. No real Copilot data on this
machine to confirm end-to-end.

## Ollama — `client/sources/ollama-source.ts`

The **desktop app** keeps chats in `~/Library/Application Support/Ollama/db.sqlite`
(`messages` table: role, content, thinking, model_name, chat_id, timestamps). One
chat = one session; user/tool messages → input, assistant+thinking → output (all
char-estimated — the db stores no token counts); model is the dominant
`model_name`. Verified against the real db (19 chats parsed).

The **Ollama CLI is not covered**: it persists no per-request token/model data
locally (the server log has no clean per-request counts; `~/.ollama/history` is
just typed prompts). Capturing CLI usage would need an API proxy in front of
`localhost:11434` — out of scope.

> ⚠️ Ollama runs on **local hardware**, so the datacenter-based carbon model is a
> poor fit; treat Ollama carbon as a very rough placeholder.

## Cursor — `client/cursor-pull.ts` (server-side)

Cursor keeps usage on its servers — there's no local file, and Agent Cat doesn't
track it either. The only path is the **Admin API** (team owner key). Unlike the
others this is a *pull*, not a local watcher:

```bash
CURSOR_API_KEY=key_... lut cursor-pull --days 30
```

It POSTs `teams/filtered-usage-events`, then ingests one event per usage event on
behalf of each member (keyed by event id, so the server upserts). Best run on the
server host on a schedule (cron/systemd), not on each laptop.

> ⚠️ **Unverified** — written to Cursor's documented Admin API shape but not yet
> run against a real key; field names may need tweaking once tested.

---

## Activating the new watchers

```bash
lut copilot enable     # or gemini / ollama
lut status             # shows every surface's state
```

Or in the desktop app: Settings → toggles appear for each detected tool. `lut
connect` auto-enables every detected surface.
