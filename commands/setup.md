# /usage-tracker:setup

Configure this machine to report Claude usage + carbon to the central server.

## Instructions

1. Ask the user for their **name** and **work email** if you don't already know them (the email identifies them in org reports). Also ask for the **server URL** if it isn't the default `http://localhost:4317`, the **ingest token** if the central server requires one (ask the server admin — omit it for a local/unsecured server), and a **device label** (e.g. "macOS", "Windows laptop") for per-device breakdowns — defaults to the detected OS if omitted.
2. Run the setup script with those values as flags (drop `--ingest-token` if not needed; `--device-name` defaults to the detected OS):

```bash
npx -y bun ${CLAUDE_PLUGIN_ROOT}/client/setup.ts --name "<NAME>" --email "<EMAIL>" --server-url "<SERVER_URL>" --ingest-token "<TOKEN>" --device-name "<DEVICE>"
```

3. Show the user the script's confirmation output (config path, user id, device, server URL).
4. If the output says Cowork was detected, tell the user they can run the Cowork watcher to also track Cowork sessions:

```bash
npx -y bun ${CLAUDE_PLUGIN_ROOT}/client/watch-cowork.ts
```

The Stop hook is wired automatically by the plugin — no settings edits are needed. New sessions report to the server on each Stop.
