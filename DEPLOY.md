# Deploying to Fly.io

## One-time setup

1. **Install `flyctl`:**
   ```bash
   brew install flyctl
   ```

2. **Authenticate:**
   ```bash
   flyctl auth login
   ```

3. **Create the app and volume (first deploy only):**
   ```bash
   cd /path/to/llm-usage-tracker
   flyctl launch
   ```
   This will:
   - Create your app — note the name you choose; it's referred to below as `<your-app>`
     (the committed `fly.toml` ships a placeholder `app = 'your-app-name'`)
   - Prompt for a region (default `sjc` = San Jose; pick your preferred one)
   - Create a persistent volume named `data` for SQLite
   - Set up auto-deploy from your GitHub repo (optional, but recommended)

4. **Push to GitHub and enable auto-deploy (optional):**
   ```bash
   git push origin main
   # Then in Fly dashboard: https://fly.io/apps/<your-app>
   # Settings → Source Control → Connect GitHub repo, auto-deploy main branch
   ```
   The CI workflow (`.github/workflows/fly-deploy.yml`) deploys with
   `flyctl deploy --app ${{ secrets.FLY_APP_NAME }}` because `fly.toml` holds a
   placeholder app name. Add two repo secrets for it to work:
   - `FLY_API_TOKEN` — from `flyctl tokens create deploy`
   - `FLY_APP_NAME` — your real app name (`<your-app>`)

## Authentication (required — fail-closed)

The server **denies all access (503)** until auth is configured — forgetting to
set the secrets locks the app rather than exposing it. Set these as Fly secrets
before/at first deploy:

```bash
flyctl secrets set \
  LUT_DASH_USER=admin \
  LUT_DASH_PASS="$(openssl rand -base64 18)" \
  LUT_INGEST_TOKEN="$(openssl rand -hex 24)" \
  -a <your-app>
```

- `LUT_DASH_PASS` (+ optional `LUT_DASH_USER`) → HTTP Basic Auth on the dashboard,
  all `/api/*`, and the live stream.
- `LUT_INGEST_TOKEN` → clients must send it on `/ingest` (set it during
  `client/setup.ts --ingest-token …`).
- `/api/health` stays open for the Fly healthcheck.

Note the values you set — share `LUT_INGEST_TOKEN` and the dashboard login with
the team. Only `LUT_ALLOW_NO_AUTH=1` runs the server open, and that is for **local
dev only** — never set it on Fly.

## Deploy updates

```bash
flyctl deploy
```

Or push to `main` if auto-deploy is enabled.

## Access your server

After `flyctl launch`, Fly assigns a domain like:
```
https://<your-app>.fly.dev
```

Update your client config to point to this URL:
```bash
bun run client/setup.ts --server-url "https://<your-app>.fly.dev"
```

The hook will POST to `https://<your-app>.fly.dev/ingest` automatically.

## View logs

```bash
flyctl logs
```

## Database backup

SQLite data is stored in the `data` volume. To back it up:
```bash
flyctl ssh console
# Inside the shell:
cd /data && sqlite3 server.db ".dump" > backup.sql
# Exit and download
```

## Scaling

For your team:
- **1-10 people**: current `shared-cpu:1, 256MB` is fine
- **10-50 people**: upgrade to `shared-cpu:2, 512MB`
- **50+ people**: consider a dedicated database (Postgres on Fly, or managed RDS)

Upgrade with:
```bash
flyctl scale vm shared-cpu-2x --memory 512
```

## Cost

- **App**: $0.0007/hour (shared CPU) → ~$5/mo
- **Volume**: $0.15/GB/mo → ~$1-2/mo for typical usage
- **Data transfer**: $0.02/GB outbound (usually $0-1/mo for your team)

**Total: ~$7-8/mo for a team of 50.**

## Org-wide rollout via claude.ai (Teams/Enterprise)

Claude Code supports **server-managed settings** pushed from the claude.ai
admin console: **Admin Settings → Claude Code → Managed settings**. Two tiers —
use both together:

### Tier 1 — managed CLAUDE.md (self-serve install on request)

The `claudeMd` field injects org-wide instructions into every member's Claude
Code, so anyone can just type *"set up the usage tracker"* and Claude knows
exactly what to do.

### Tier 2 — zero-touch (managed hook + env; nothing to install)

Managed settings can push the Stop hook and env vars themselves. The hook
self-bootstraps `lut` on first run (downloading the latest release binary),
and from v1.4.0 `lut hook` needs **no local config**: with `LUT_SERVER_URL`
set it derives the user's identity from `git config user.name/user.email`
(or `LUT_NAME`/`LUT_EMAIL` env). Users who later run `lut connect` override
the fallback with their explicit details.

Paste into the managed settings JSON (fill in your token):

```json
{
  "env": {
    "LUT_SERVER_URL": "https://<your-app>.fly.dev",
    "LUT_INGEST_TOKEN": "<your LUT_INGEST_TOKEN>"
  },
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh -c '[ -x \"$HOME/.local/bin/lut\" ] || curl -fsSL https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/install.sh | LUT_NO_CONNECT=1 bash >/dev/null 2>&1; \"$HOME/.local/bin/lut\" hook'",
            "async": true,
            "timeout": 60
          }
        ]
      }
    ]
  },
  "claudeMd": "## Team usage tracking\nThis org tracks LLM usage (token counts, carbon estimates and a work-type label only — never prompts or code) on a central dashboard.\nIf the user asks to set up, install, fix or check 'usage tracking' / 'the usage tracker':\n1. Ask for their name, work email, and the ingest token (from 1Password, entry 'usage tracker').\n2. Run: LUT_NAME=\"<name>\" LUT_EMAIL=<email> LUT_SERVER_URL=https://<your-app>.fly.dev LUT_INGEST_TOKEN=<token> bash -c \"$(curl -fsSL https://raw.githubusercontent.com/versantus/llm-usage-tracker/main/install.sh)\"\n   (Windows PowerShell: set the same values as $env: vars then `irm .../install.ps1 | iex`.)\n3. Verify with `lut status` — report whether it shows 'server up: yes' and 'hook: wired' in plain language.\nOpt-outs: `lut connect --no-category` disables work-type labels."
}
```

Notes and caveats:

- **The managed hook command is POSIX `sh`** — it covers macOS/Linux. Windows
  users still run the installer once (or use the tray); managed hooks are a
  single command string, so a cross-platform one-liner isn't practical.
- **Identity in zero-touch mode comes from git config.** If someone's git
  email is a GitHub noreply address, they'll appear under that address until
  they run `lut connect` with their work email (which then takes precedence —
  but shows as a *second* user on the dashboard, since users are keyed by
  email). Teams that care should still encourage the one-time `lut connect`.
- **The token is distributed to every org member** via env — it's the same
  shared ingest token they'd get from 1Password anyway.
- **Zero-touch covers Claude Code only.** Cowork/Codex/Copilot/etc. watchers
  still need the one-time installer per machine (Cowork has no managed-settings
  channel).
- If a user has BOTH the managed hook and a self-installed hook, sessions are
  reported twice — harmlessly (the server upserts absolute totals; nothing
  double-counts).
