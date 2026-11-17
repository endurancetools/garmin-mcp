---
title: Configuration
description: "Garmin MCP settings: automatic downloads, opt-in delete tools, the network server and sign-in, as environment variables or config.json, with defaults."
nav_order: 6
---
Everything works without configuration. Settings are environment variables passed by your client (see the client guides), or lines in `~/.garmin-mcp/config.json`. Precedence: command-line flag, then environment, then `config.json`, then the default.

## The ones you may want

| Variable | Default | Meaning |
| --- | --- | --- |
| `GARMIN_AUTO_FETCH` | `true` | the server downloads missing days by itself; `false`: it reports what is missing and the assistant asks you first |
| `GARMIN_AUTO_LOGIN` | `true` | the server opens Garmin's sign-in page in your browser when a question needs Garmin and nobody is signed in; `false`: you sign in with `garmin-mcp-cli login` ([Signing in](sign-in.md)) |
| `GARMIN_ENABLE_DESTRUCTIVE` | `false` | `true` adds deleting activities, workouts and weigh-ins, and overwriting saved workouts |
| `GARMIN_REDACT` | `true` | the raw activity output (`get_activity` with `detail: "full"`) leaves out your name, profile and photo links, device and sensor serial numbers and GPS positions; `false` returns Garmin's data as sent |
| `GARMIN_DATA_DIR` | `~/.garmin-mcp` | where tokens, the database and `config.json` live |
| `GARMIN_FIT_DOWNLOAD_DIR` | `~/.garmin-mcp/downloads` | where activity files are saved |
| `GARMIN_TIMEZONE` | your system's | IANA zone used for "today" and week boundaries |
| `GARMIN_REGION` | `global` | `cn` for Garmin China accounts |
| `GARMIN_BROWSER_PATH` | detected | browser used for the sign-in window |
| `GARMIN_ENABLED_TOOLS`, `GARMIN_DISABLED_TOOLS` | | comma-separated lists to expose only some tools |
| `GARMIN_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`; logs go to stderr |

## Downloads

| Variable | Default | Meaning |
| --- | --- | --- |
| `GARMIN_SYNC_CHUNK_DAYS` | `7` | days per download chunk |
| `GARMIN_SYNC_PAUSE_S` | `1-11` | pause after a chunk that downloaded something: a number, or a random range |
| `GARMIN_SYNC_MAX_REQUESTS_PER_DAY` | `600` | daily request budget; a 429 or Cloudflare challenge pauses everything for 6 h |
| `GARMIN_CONCURRENCY` | `4` | parallel requests |
| `GARMIN_MIN_REQUEST_INTERVAL_MS` | `250` | spacing between requests |

## Network server

| Variable | Default | Meaning |
| --- | --- | --- |
| `GARMIN_MCP_TRANSPORT` | `stdio` | `streamable-http` for a network server |
| `GARMIN_MCP_HOST`, `GARMIN_MCP_PORT` | `127.0.0.1`, `8000` | where it listens |
| `GARMIN_MCP_HTTP_TOKEN` | | required `Authorization: Bearer` token; without it the server only listens on localhost |
| `GARMIN_HTTP_ALLOWED_HOSTS` | | extra hostnames accepted in `Host`/`Origin` besides `localhost`, `127.0.0.1`, `[::1]` |

## Sign-in

| Variable | Default | Meaning |
| --- | --- | --- |
| `GARMIN_SSO_STRATEGY` | `auto` | `auto` (browser if available, else terminal), `browser`, `curl`, `fetch`, `import` |
| `GARMIN_EMAIL`, `GARMIN_PASSWORD` | | only for the terminal sign-in, only at sign-in time |
| `GARMIN_TOKENS_FILE` | `$GARMIN_DATA_DIR/tokens.json` | |

## config.json

The same settings, in camelCase, for example:

```json
{
  "autoFetch": false,
  "timezone": "Europe/Warsaw"
}
```

## Several Garmin accounts

One server serves one Garmin account. For two people on one computer, add two servers with a different `GARMIN_DATA_DIR` each. Everything that belongs to an account lives in its data directory: tokens, the database, `config.json`, downloaded activity files, the daily request count and a rate-limit pause. Two servers share nothing else, so they can run at the same time. In Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "garmin-anna": {
      "command": "npx",
      "args": ["-y", "garmin-mcp-server"],
      "env": { "GARMIN_DATA_DIR": "~/.garmin-mcp-anna" }
    },
    "garmin-jan": {
      "command": "npx",
      "args": ["-y", "garmin-mcp-server"],
      "env": { "GARMIN_DATA_DIR": "~/.garmin-mcp-jan" }
    }
  }
}
```

In Claude Code:

```bash
claude mcp add garmin-anna --scope user --env GARMIN_DATA_DIR=~/.garmin-mcp-anna -- npx -y garmin-mcp-server
claude mcp add garmin-jan --scope user --env GARMIN_DATA_DIR=~/.garmin-mcp-jan -- npx -y garmin-mcp-server
```

Sign each one in with the CLI and the same directory:

```bash
npx -y garmin-mcp-cli login --data-dir ~/.garmin-mcp-anna
npx -y garmin-mcp-cli login --data-dir ~/.garmin-mcp-jan
```

Or let each server open the sign-in page on its first question. The sign-in window starts with an empty browser profile every time, so it never remembers the other person's Garmin session; sign in there as the person the server belongs to. Every CLI command takes `--data-dir`, for example `npx -y garmin-mcp-cli status --data-dir ~/.garmin-mcp-jan`.

Keep in mind:

- Set `GARMIN_TOKENS_FILE` and `GARMIN_FIT_DOWNLOAD_DIR` per server, or not at all. Set once for both (for example in your shell profile), they point both servers at the same file or folder.
- Two network servers (`GARMIN_MCP_TRANSPORT=streamable-http`) need different `GARMIN_MCP_PORT` values; the second one on a taken port stops with `EADDRINUSE`.
- The daily request budget counts per account. Both accounts reach Garmin from the same internet address, so a heavy first sync is better done for one account at a time.
- The Claude Desktop extension installs once, with one data directory. Add the second account as a `claude_desktop_config.json` entry like the one above.
- With Docker, give each account its own volume, for example `-v garmin-anna:/data` and `-v garmin-jan:/data`.
