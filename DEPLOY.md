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
