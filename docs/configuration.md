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
