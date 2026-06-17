# Tracking more tools: Gemini, Copilot, Cursor

Research notes on extending the tracker to **Gemini CLI**, **GitHub Copilot**, and
**Cursor**, based on what each writes to disk and on how
[Agent Cat's connectors](https://github.com/yong076/agentcat-connectors) do it
(its open-source collector was inspected directly at
`~/.agentcat/connectors/bin/agentcat`).

TL;DR feasibility:

| Tool | Local token data? | Approach | Carbon |
|------|-------------------|----------|--------|
| **Gemini CLI** | Only if OpenTelemetry is enabled | Turn on telemetry → parse the local OTLP log | approx (no validated Gemini config) |
| **GitHub Copilot** | Yes (partial) | Parse local CLI logs + VS Code chat transcripts | approx (output often char-estimated) |
| **Cursor** | **No** | Server-side Admin API only — not a local hook | n/a locally |

The existing `Provider`/`Surface` unions in `shared/types.ts` already include
`google`, `openai`, `cursor`, so adding these is mostly new *sources*.

---

## Gemini CLI — feasible via telemetry

Gemini CLI does **not** persist token usage in its session logs. `~/.gemini/tmp/<hash>/logs.json`
holds prompts and `chats/*.json` holds message content, but neither has token
counts (confirmed: no `tokenCount`/`usageMetadata` anywhere under `~/.gemini`).

It *does* emit OpenTelemetry. Agent Cat enables it by writing this into
`~/.gemini/settings.json` (seen live on this machine — Agent Cat set it):

```json
"telemetry": {
  "enabled": true,
  "logPrompts": false,
  "outfile": "/Users/<you>/.agentcat/gemini/telemetry.log",
  "target": "local"
}
```

Then it tails that OTLP log and sums the metric **`gemini_cli.token.usage`**
(falling back to `gen_ai.client.token.usage`), reading incrementally with an
offset/size bookmark. Token classes (input/output/cache) come from the metric's
attributes; the model from the resource/scope attributes.

**Plan for us:** `lut gemini enable` writes the telemetry block into
`~/.gemini/settings.json` (read-modify-write, our own outfile under
`~/.config/llm-usage-tracker/gemini-telemetry.log`), then a `watch-gemini`
watcher tails it and reports per-session absolute totals. Carbon is approximate
(no validated Gemini energy config — falls back like other non-Anthropic models).

> ⚠️ Verification: on this machine the telemetry log is currently **empty**
> (`status: no_token_events_yet`) — Gemini hasn't run since telemetry was turned
> on, so the parser needs a live Gemini session (or a synthetic OTLP fixture) to
> verify end-to-end before shipping.

---

## GitHub Copilot — feasible from local logs

Two local sources (Agent Cat reads both):

1. **Copilot CLI** — `~/.copilot/session-state/<workspace-hash>/events.jsonl`
2. **VS Code Copilot Chat** —
   `<workspaceStorage>/<hash>/GitHub.copilot-chat/transcripts/*.jsonl`
   (workspaceStorage = `~/Library/Application Support/Code/User/workspaceStorage`
   on macOS; `~/.config/Code/...` on Linux; `%APPDATA%/Code/...` on Windows).

Transcript shape: first line `{"type":"session.start","data":{"producer":"copilot-agent"}}`,
then `user.message` (→ input) and `assistant.message` events. Output tokens come
from `data.outputTokens` when present, else a **char/4 estimate** of
`data.content`; `data.reasoningText` adds reasoning tokens; `data.toolRequests`
gives the tool breakdown.

**Plan for us:** a `copilot-source` parsing those JSONL files (absolute per-file
totals, upsert dedups) + `lut copilot enable` watcher. Carbon approximate —
output is frequently estimated, not measured.

> ⚠️ Verification: this machine has **no Copilot data** (`~/.copilot/session-state`
> absent; no `GitHub.copilot-chat/transcripts`), so Agent Cat reports Copilot
> `tokens: 0`. Needs a synthetic transcript fixture or a real Copilot session to
> verify.

---

## Cursor — not trackable locally

Agent Cat **does not track Cursor** — there is no Cursor token source in its
collector (every "cursor" reference in its code is the JSONL *offset* bookmark,
not the editor). Cursor keeps per-request usage **server-side**; its local
`state.vscdb` only exposes coarse signals like `aiCodeTrackingLines`, not tokens.

The only real path is **Cursor's Admin API** (team owners, requires an API key):
a *server-side* puller that pulls per-member usage on a schedule and ingests it —
not a local hook. That belongs on the central server, not in `lut`. Out of scope
for the local-watcher model unless we add a server-side connector.

---

## Suggested implementation order

1. **Copilot** — pure local-file parsing, fits the existing source/watcher
   pattern exactly; just needs a fixture to verify.
2. **Gemini** — adds settings.json telemetry wiring + an OTLP tail; verify with a
   live session.
3. **Cursor** — only if we want a server-side Admin-API puller; different shape
   from the local watchers.
