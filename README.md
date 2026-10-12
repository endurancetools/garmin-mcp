# Garmin MCP

[![npm](https://img.shields.io/npm/v/garmin-mcp-server)](https://www.npmjs.com/package/garmin-mcp-server)
[![CI](https://github.com/endurancetools/garmin-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/endurancetools/garmin-mcp/actions/workflows/ci.yml)
[![MCP registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0.1%2Fservers%2Fio.github.endurancetools%252Fgarmin-mcp%2Fversions&query=%24.servers%5B-1%3A%5D.server.version&label=MCP%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.endurancetools%2Fgarmin-mcp/versions)

An MCP server that gives your AI assistant your Garmin Connect data: activities, health, sleep, training status, body composition, gear, devices, the workout library and the calendar. It keeps a local SQLite cache, downloads only what a question needs, and can build, preview and schedule structured workouts that sync to the watch.

Works with Claude Code, Claude Desktop, Codex, Antigravity CLI, opencode and any other MCP client (stdio or streamable HTTP).

**Documentation: [endurancetools.github.io/garmin-mcp](https://endurancetools.github.io/garmin-mcp/)** (getting started per client, what to ask, configuration, troubleshooting). Contributing and development: [DEVELOPMENT.md](DEVELOPMENT.md).

## Getting started

Requirements: Node.js 22 or newer, a Garmin Connect account, and Chrome, Edge, Brave or Chromium for the sign-in window (there is a terminal fallback).

**1. Sign in once.** This opens Garmin's own sign-in page in your browser. Your password never passes through the tool; only the tokens Garmin issues are stored, in `~/.garmin-mcp`.

```bash
npx -y garmin-mcp-cli login
```

**2. Add the server to your client.**

| Client | Configuration |
| --- | --- |
| Claude Code | `claude mcp add garmin -- npx -y garmin-mcp-server` |
| Claude Desktop | install `garmin-mcp-<version>.mcpb` from the [GitHub release](https://github.com/endurancetools/garmin-mcp/releases), or add to `claude_desktop_config.json`: `{"mcpServers":{"garmin":{"command":"npx","args":["-y","garmin-mcp-server"]}}}` |
| Codex | `~/.codex/config.toml`: `[mcp_servers.garmin]` `command = "npx"` `args = ["-y", "garmin-mcp-server"]` |
| Antigravity CLI | `agy mcp add garmin npx -y garmin-mcp-server` |
| opencode | `opencode.json`: `{"mcp":{"garmin":{"type":"local","command":["npx","-y","garmin-mcp-server"],"enabled":true}}}` |
| Any other client | command `npx`, arguments `-y garmin-mcp-server`, transport stdio |

**3. Ask.** Nothing is downloaded until a question needs it. For example:

- "How did I sleep this week?" or "How did my HRV trend over the summer?"
- "Review my training week" or "Summarise my block from 2026-08-04 to 2026-09-28"
- "Am I fatigued? What is my form right now?"
- "When is my next race?" or "What is planned this week?"
- "Build me 6×400 m with 90 s rest for Thursday" (you see the steps first, nothing is saved until you agree)
- "Rename activity 21001 to Parkrun PB"

Optional: pre-load a range so the first questions answer instantly.

```bash
npx -y garmin-mcp-cli sync --scope all --from 2026-07-01 --to 2026-09-30
```

## How it fetches data

Logging in and starting the server download nothing. When a question needs days that are not in the local database, the tool downloads exactly that range, waits up to 20 s and answers; anything left keeps downloading in the background and the answer says so (`meta.source` is `partial`). Everything downloaded stays in the local database: stored days are never downloaded again unless you pass `--force`, so repeating a question costs nothing.

To stay gentle with Garmin, long ranges go in 7-day chunks, newest first, with a random 1-11 s pause after each chunk that actually downloaded something, at most 600 requests per day. A 429 or a Cloudflare challenge pauses all downloads for 6 h. An interrupted sync continues where it left off.

With `GARMIN_AUTO_FETCH=false` nothing is downloaded unless you run `garmin sync` or the `garmin_sync` tool; read tools then return the missing range in `meta.sync_hint` and the model asks you first.

Measured on a real account after a 90-day sync (433 requests in about an hour): answers come from the local database in 1-110 ms.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_activities` | dense activity list with cursor paging; `type` takes a Garmin type key (all keys in `garmin://activity-types`) |
| `get_activity` | one activity: `summary`, `splits`, `hr_zones`, `power_zones`, `weather`, `exercise_sets` (strength sets), or `full` (all sections plus the raw stream, 50 KB pages) |
| `update_activity` | name, type, description, RPE, feel |
| `download_activity_file` | FIT (unzipped), GPX, TCX, KML, CSV to the download directory (`GARMIN_FIT_DOWNLOAD_DIR`) |
| `query_health` | steps (with daily distance), resting HR (with daily min/max HR), HRV (with status and baseline), sleep, stress, body battery, respiration, SpO2, intensity minutes, calories, floors; per day or week, with 7/28-day trends |
| `get_sleep` | one night with stages, or a range with averages |
| `get_training_status` | VO2max, readiness, recovery time, Garmin status, load and load focus, computed CTL/ATL/TSB (optionally the daily series); race predictions, endurance/hill score, fitness age, personal records, acclimation |
| `get_body_composition` | weigh-ins in kg with trend |
| `get_period_summary` | week, month or any `from`..`to` range up to 366 days: volume per sport, HR zones, rest days, longest/hardest, load at the end, health and energy averages |
| `list_workouts`, `get_workout` | workout library, scheduled workouts, races and events from the calendar in any date range (default: next 60 days), readable steps |
| `preview_workout`, `create_workout`, `schedule_workouts` | workouts from presets (run intervals, walk/run, easy Z2, strength circuit) or a typed definition (nestable repeats, HR/pace/power targets); `preview_workout` shows the steps and estimated duration without saving; `schedule_workouts` puts workouts on the calendar and takes them off again |
| `get_gear`, `get_devices` | gear with distance, devices with last sync and settings |
| `garmin_sync` | explicit download of a scope (all/activities/health/training/reference) and date range, with progress notifications |

`delete_activity`, `delete_workout`, `delete_weigh_in` and overwriting a saved workout (`create_workout` with `workout_id`) are only available with `GARMIN_ENABLE_DESTRUCTIVE=true`.

Resources: `garmin://profile`, `garmin://gear`, `garmin://devices`, `garmin://activity-types`, `garmin://sync-status`, and the templates `garmin://activity/{id}` and `garmin://workout/{id}` with id completion. Prompts: `weekly_review`, `plan_next_week`.

Every response is `{ data, meta: { source: cache|live|partial|local, fetched_at, coverage?, sync_hint? } }`, as JSON text and as `structuredContent` matching the tool's `outputSchema`; failures are `{ error: { code, message, hint } }`.

Which Garmin Connect data is covered, and what is still missing: [docs/coverage.md](docs/coverage.md).

## CLI

`garmin-mcp-cli` shares the core with the server and is handy for setup and checks:

```
garmin login [--strategy auto|browser|curl|fetch] [--email] [--token-path]
garmin import-tokens <file>          # garmin_tokens.json from python-garminconnect 0.3.x
garmin status [--json]
garmin sync [--scope ...] [--from --to] [--force] [--pause <s>]   # default: last 7 days
garmin activities [--from --to --type --limit --json]
garmin health <metric> [--from --to --week --json]
garmin doctor                        # TLS strategy, hosts, permissions, tokens, SQLite driver
garmin serve [--transport stdio|streamable-http] [--port]
garmin logout
```

Run it with `npx -y garmin-mcp-cli <command>` or install it globally (`npm i -g garmin-mcp-cli`).

## Signing in

`garmin login` opens Garmin's real sign-in page in your installed Chrome, Edge, Brave or Chromium (a temporary profile, removed afterwards). You sign in there, including MFA or a CAPTCHA if Garmin asks; the tool only catches the one-time ticket Garmin redirects to afterwards and exchanges it for tokens. Cloudflare sees a real browser. Set `GARMIN_BROWSER_PATH` if your browser is not found.

Without a browser (headless server, Docker) or with `--strategy curl|fetch`, it asks for e-mail, password and MFA in the terminal and talks to Garmin's mobile login API, trying curl-impersonate (optional `cuimp` package, downloads its binary on first use) and then plain fetch. If that is blocked too, log in with Python and import the tokens; `garmin doctor` prints the exact command:

```bash
uvx --with "garminconnect>=0.3" python <path>/python-login.py ~/.garmin-mcp/garmin_tokens.json
garmin import-tokens ~/.garmin-mcp/garmin_tokens.json
```

Tokens and the database are 0600 inside a 0700 directory; the server refuses to start on looser permissions.

## Remote and Docker

Streamable HTTP: `GARMIN_MCP_TRANSPORT=streamable-http GARMIN_MCP_HTTP_TOKEN=<secret> npx -y garmin-mcp-server` serves `POST /mcp` with `Authorization: Bearer <secret>`. Without a token it only binds to 127.0.0.1. Requests whose `Host` or `Origin` is not `localhost`, `127.0.0.1` or `[::1]` get 403 (DNS rebinding protection); behind a public hostname add it with `GARMIN_HTTP_ALLOWED_HOSTS=mcp.example.com`.

The server speaks MCP 2026-07-28 (`server/discover`, list results cached for an hour) and the 2025 revisions through the usual `initialize` handshake, on stdio and on HTTP, so clients on older MCP SDKs connect unchanged.

Docker: `docker build -t garmin-mcp . && docker run -i -v garmin-data:/data garmin-mcp` (log in with `docker run -it -v garmin-data:/data garmin-mcp login`).

## Configuration

Precedence: CLI flag > environment > `<data dir>/config.json` > default. `~`, `$HOME` and `${HOME}` are always expanded.

| Variable | Default | |
| --- | --- | --- |
| `GARMIN_DATA_DIR` | `~/.garmin-mcp` | tokens, database, config.json |
| `GARMIN_TOKENS_FILE` | `$GARMIN_DATA_DIR/tokens.json` | |
| `GARMIN_EMAIL`, `GARMIN_PASSWORD` | | first login only |
| `GARMIN_REGION` | `global` | `cn` switches all three hosts |
| `GARMIN_SSO_STRATEGY` | `auto` | `auto` (browser if installed, else terminal), `browser`, `curl`, `fetch`, `import` |
| `GARMIN_BROWSER_PATH` | detected | Chrome/Edge/Brave/Chromium used for the sign-in window |
| `GARMIN_ENABLED_TOOLS`, `GARMIN_DISABLED_TOOLS` | | comma-separated allow/deny lists |
| `GARMIN_ENABLE_DESTRUCTIVE` | `false` | delete tools and workout overwrite |
| `GARMIN_AUTO_FETCH` | `true` | read tools download missing data themselves; `false`: only explicit syncs |
| `GARMIN_FIT_DOWNLOAD_DIR` | `$GARMIN_DATA_DIR/downloads` | |
| `GARMIN_MCP_TRANSPORT`, `GARMIN_MCP_PORT`, `GARMIN_MCP_HOST`, `GARMIN_MCP_HTTP_TOKEN` | `stdio`, `8000`, `127.0.0.1`, | |
| `GARMIN_HTTP_ALLOWED_HOSTS` | | comma-separated hostnames (no port, IPv6 in brackets) accepted in `Host`/`Origin` on top of `localhost`, `127.0.0.1`, `[::1]`; others get 403 |
| `GARMIN_LOG_LEVEL` | `info` | pino JSON on stderr |
| `GARMIN_TIMEZONE` | system | IANA zone for "today" |
| `GARMIN_CONCURRENCY` | `4` | parallel connectapi requests |
| `GARMIN_MIN_REQUEST_INTERVAL_MS` | `250` | spacing between request starts (±25 % jitter) |
| `GARMIN_SYNC_CHUNK_DAYS` / `GARMIN_SYNC_PAUSE_S` / `GARMIN_SYNC_MAX_REQUESTS_PER_DAY` | `7` / `1-11` / `600` | pacing of syncs; the pause is seconds, a random range or a fixed number |
| `GARMIN_DI_CLIENT_IDS`, `GARMIN_APP_VERSION`, `GARMIN_APP_USER_AGENT` | built in | for when Garmin changes the mobile app identity |

## More

- [DEVELOPMENT.md](DEVELOPMENT.md): monorepo layout, tests, tool-list budget, evals, release.
- [docs/coverage.md](docs/coverage.md): every Garmin Connect read and write and the tool that serves it.
- [CHANGELOG.md](CHANGELOG.md).
- License: [MIT](LICENSE). Author: [Marcin Milewicz](https://marcinmilewicz.pl) ([LinkedIn](https://www.linkedin.com/in/marcinmilewicz/)).
