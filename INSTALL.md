# Install (Claude Code)

How to install the **LLM Usage Tracker** plugin so your Claude Code sessions are
counted in the team's central usage + carbon dashboard. Takes about a minute.

> You only need this if you're a **user** reporting your own usage. Running the
> central server is a separate job — see [DEPLOY.md](./DEPLOY.md).

## What you'll need

- **Claude Code** installed.
- Access to the private repo `your-org/llm-usage-tracker` (ask the team if the
  next step can't find it).
- The **server URL** and an **ingest token** from whoever runs the server
  (default server: `https://your-server.example.com`).

## 1. Add the marketplace and install the plugin

In Claude Code, run:

```
/plugin marketplace add your-org/llm-usage-tracker
/plugin install usage-tracker@llm-usage-tracker
```

The plugin wires a **Stop hook** automatically — no settings edits, no
long-running process. After each session ends, it parses that session's
transcript, estimates the carbon, and reports the totals.

<details>
<summary>No GitHub access? Install from a local clone instead</summary>

```bash
git clone https://github.com/your-org/llm-usage-tracker.git
```

Then in Claude Code:

```
/plugin marketplace add /full/path/to/llm-usage-tracker
/plugin install usage-tracker@llm-usage-tracker
```
</details>

## 2. Tell it who you are + where to report

Run the setup command in Claude Code:

```
/usage-tracker:setup
```

It will ask for your **name**, **work email** (this identifies you in reports),
the **server URL**, and the **ingest token**. Or run it directly:

```bash
npx -y bun ${CLAUDE_PLUGIN_ROOT}/client/setup.ts \
  --name "Your Name" \
  --email you@example.com \
  --server-url https://your-server.example.com \
  --ingest-token <TOKEN>
```

That's it. New Claude Code sessions now report to the server on each Stop.

## 3. Check it's working

- **Dashboard:** open the server URL in a browser (you'll be prompted for the
  shared dashboard login). Your name should appear in the Users table after your
  next session ends. Click your row to see your model + over-time breakdown.
- **CLI report:**

  ```bash
  npx -y bun ${CLAUDE_PLUGIN_ROOT}/cli/report.ts --days 30
  ```

  If the server requires a dashboard login, set `LUT_DASH_USER` / `LUT_DASH_PASS`
  in your environment first.

## Optional: also track Cowork

Cowork has no hook surface, so it needs a small watcher running in the background:

```bash
npx -y bun ${CLAUDE_PLUGIN_ROOT}/client/watch-cowork.ts
```

## Slash commands

- `/usage-tracker:setup` — configure identity + server
- `/usage-tracker:report` — show your usage/carbon report
- `/usage-tracker:dashboard` — start + open the live dashboard

## Privacy & data

Only **token counts, model names, timestamps, and your name/email** are sent — no
prompts, code, or file contents ever leave your machine. Config lives at
`~/.config/claude-usage-tracker/config.json`; if the server is unreachable,
events are spooled locally and retried on your next session.
</content>
</invoke>
