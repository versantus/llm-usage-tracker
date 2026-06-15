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
   cd /path/to/claude-usage-tracker
   flyctl launch
   ```
   This will:
   - Create an app called `llm-usage-tracker`
   - Prompt for a region (default `sjc` = San Jose; pick your preferred one)
   - Create a persistent volume named `data` for SQLite
   - Set up auto-deploy from your GitHub repo (optional, but recommended)

4. **Push to GitHub and enable auto-deploy (optional):**
   ```bash
   git push origin main
   # Then in Fly dashboard: https://fly.io/apps/llm-usage-tracker
   # Settings → Source Control → Connect GitHub repo
   # Auto-deploy main branch
   ```

## Deploy updates

```bash
flyctl deploy
```

Or push to `main` if auto-deploy is enabled.

## Access your server

After `flyctl launch`, Fly assigns a domain like:
```
https://your-server.example.com
```

Update your client config to point to this URL:
```bash
bun run client/setup.ts --server-url "https://your-server.example.com"
```

The hook will POST to `https://your-server.example.com/ingest` automatically.

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
