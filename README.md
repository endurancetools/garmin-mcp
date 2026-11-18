# Garmin MCP

[![npm](https://img.shields.io/npm/v/garmin-mcp-server)](https://www.npmjs.com/package/garmin-mcp-server)
[![CI](https://github.com/endurancetools/garmin-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/endurancetools/garmin-mcp/actions/workflows/ci.yml)
[![MCP registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0.1%2Fservers%2Fio.github.endurancetools%252Fgarmin-mcp%2Fversions%2Flatest&query=%24.server.version&label=MCP%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.endurancetools%2Fgarmin-mcp/versions/latest)

**Ask your AI assistant how your training is really going.** Garmin MCP is an unofficial, open-source MCP server for your Garmin Connect data: training load, form and morning readiness computed on your machine with methods from published sports-science literature, with citations; 21 tools designed around the questions athletes ask, not a mirror of Garmin's API; a local SQLite cache that downloads only what a question needs; and structured workouts that go from the answer to your Garmin calendar and watch. It also reads activities, health, sleep, training status, body composition, gear, devices and the workout library.

![Terminal recording of Claude Code with Garmin MCP. Asked "Can I train hard today?", it advises a modified session, citing resting heart rate, sleep and training load. Asked to build 6x400 m with 90 s rest for Thursday, it shows the workout steps and asks before saving anything.](https://endurancetools.github.io/garmin-mcp/assets/images/demo.gif)

Works with Claude Code, Claude Desktop, Codex, Antigravity CLI, opencode and any other MCP client (stdio or streamable HTTP).

**Documentation: [endurancetools.github.io/garmin-mcp](https://endurancetools.github.io/garmin-mcp/)** (getting started per client, what to ask, configuration, troubleshooting). Contributing and development: [DEVELOPMENT.md](DEVELOPMENT.md).

Unofficial. Garmin and Garmin Connect are trademarks of Garmin Ltd. or its subsidiaries; this project is not affiliated with or endorsed by Garmin. The training analytics (`get_load`, `get_readiness`) are training information, not medical advice.

## Why Garmin MCP

- **Answers you can check.** Training load (TSS from power, pace, heart rate or session RPE), fitness, fatigue and form (CTL/ATL/TSB), ACWR, intensity distribution and morning readiness from your own HRV, resting heart rate, sleep and load against your own baselines, with methods from published sports-science literature, with citations. Every answer returns the values and rules it used, and you can change them. [Methods and evidence](https://endurancetools.github.io/garmin-mcp/methods/)
- **Designed tools, not an API mirror.** 21 tools built around questions like "review my week" or "can I train hard today?", so one call answers one question. The whole tool list costs the model about 9,700 tokens of context, and in the last full tool-selection eval the first tool call was the right one in 96 of 96 scenarios. [Designed tools](https://endurancetools.github.io/garmin-mcp/how-it-works/#designed-tools)
- **Local and private.** You sign in on Garmin's own page, so your password never passes through the tool. What it downloads stays in a local database on your computer, answers come back from it in milliseconds, downloads are paced to stay gentle with Garmin, and tool answers go only to the AI client you connect. [What is stored where](https://endurancetools.github.io/garmin-mcp/how-it-works/#what-is-stored-where)
- **From answer to watch.** Ask for "6×400 m with 90 s rest on Thursday": you see the steps and estimated duration first, nothing is saved until you agree, and then it goes to your Garmin calendar and syncs to the watch. [Workouts and calendar](https://endurancetools.github.io/garmin-mcp/asking/#workouts-and-calendar)

## Getting started

Requirements: Node.js 22 or newer, a Garmin Connect account, and Chrome, Edge, Brave or Chromium for the sign-in window (there is a terminal fallback).

**1. Add the server to your client.**

| Client | Configuration |
| --- | --- |
| Claude Code | `claude mcp add garmin -- npx -y garmin-mcp-server` |
| Claude Desktop | install `garmin-mcp-<version>.mcpb` from the [GitHub release](https://github.com/endurancetools/garmin-mcp/releases), or add to `claude_desktop_config.json`: `{"mcpServers":{"garmin":{"command":"npx","args":["-y","garmin-mcp-server"]}}}` |
| Codex | `~/.codex/config.toml`: `[mcp_servers.garmin]` `command = "npx"` `args = ["-y", "garmin-mcp-server"]` |
| Antigravity CLI | `agy mcp add garmin npx -y garmin-mcp-server` |
| opencode | `opencode.json`: `{"mcp":{"garmin":{"type":"local","command":["npx","-y","garmin-mcp-server"],"enabled":true}}}` |
| Any other client | command `npx`, arguments `-y garmin-mcp-server`, transport stdio |

**2. Sign in when it asks.** The first question that needs Garmin opens Garmin's own sign-in page in your browser; sign in there (MFA included) and ask again if the assistant says it is still waiting. Your password never passes through the tool; only the tokens Garmin issues are stored, in `~/.garmin-mcp`. To sign in beforehand, or where the server cannot open a browser (Docker, a remote HTTP server, `GARMIN_AUTO_LOGIN=false`), use the terminal:

```bash
npx -y garmin-mcp-cli login
```

**3. Ask.** Nothing is downloaded until a question needs it. For example:

- "How did I sleep this week?" or "How did my HRV trend over the summer?"
- "Review my training week" or "Summarise my block from 2026-08-04 to 2026-09-28"
- "Am I fatigued? What is my form right now?"
- "When is my next race?" or "What is planned this week?"
- "Build me 6×400 m with 90 s rest for Thursday" (you see the steps first, nothing is saved until you agree)
- "Rename activity 21001 to Parkrun PB", "Mark Saturday's trail run as a race" or "Put my new Speedgoats on yesterday's run"

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
| `get_activities` | dense activity list with cursor paging (GAP, cadence, NP, Training Effect label, temperature when downloaded); `type` takes a Garmin type key (all keys in `garmin://activity-types`), plus `event_type` (e.g. `race`), `name`, `min_duration_min`/`max_duration_min` and a `pace` range |
| `get_activity` | one activity: `summary` (with running dynamics, breathing, stamina, run/walk/stand time, HR source), `splits` (laps with dynamics and workout steps, plus typed splits: run, walk, stand and ClimbPro climbs, with totals per type), `hr_zones`, `power_zones`, `weather`, `exercise_sets` (strength sets), `stream_summary` (stream per km, 5 min, half, quarter or climb, climbs with VAM and W/kg), `power_curve` (best power for 1 s to 60 min from the FIT file, in W and W/kg), or `full` (all sections plus the raw stream, 50 KB pages, optional `metrics` and `downsample_s`) |
| `update_activity` | name, type, event type (race, training...), description, RPE, feel, privacy, and the gear used (`add_gear`, `remove_gear` by name or uuid); without `id` it adds a manual activity (type, local start, duration, optionally distance), shown to you before it is saved |
| `download_activity_file` | FIT (unzipped), GPX, TCX, KML, CSV to the download directory (`GARMIN_FIT_DOWNLOAD_DIR`) |
| `query_health` | steps (with daily distance), resting HR (with daily min/max HR), HRV (with status and baseline), sleep, stress, body battery, respiration, SpO2, intensity minutes, calories (burned, and eaten when a food log is linked), floors, hydration (water drunk, goal, sweat loss); per day or week, with 7/28-day trends, or per hour for up to 3 days with the peak and lowest hour and Body Battery events |
| `get_sleep` | one night with stages and its timeline (stage segments, awakenings, lowest heart rate, HRV and SpO2 with their times), or a range with averages |
| `get_training_status` | VO2max, readiness, recovery time, Garmin status, load and load focus, `garmin_load_model` (CTL/ATL/TSB from Garmin's training load, optionally the daily series); race predictions, endurance/hill score, fitness age, personal records, acclimation |
| `get_body_composition` | weigh-ins in kg with trend |
| `get_period_summary` | week, month or any `from`..`to` range up to 366 days: volume per sport, HR zones, rest days, longest/hardest, `garmin_load_model` at the end, health and energy averages |
| `list_workouts`, `get_workout` | workout library, scheduled workouts and the workouts of a Garmin Coach or other training plan (with the plan's phase, dates and target event), races and events (with the course of a race) from the calendar in any date range (default: next 60 days), readable steps |
| `create_workout`, `schedule_workouts` | workouts from presets (run intervals, walk/run, easy Z2, strength circuit) or a typed definition (nestable repeats, HR/pace/power targets); `create_workout` with `dry_run: true` shows the steps and estimated duration without saving; `schedule_workouts` puts workouts on the calendar and takes them off again |
| `get_gear`, `get_devices` | gear with distance, devices with last sync, settings and, for a solar device, the solar input of the last 7 days |
| `garmin_sync` | explicit download of a scope (all/activities/health/training/reference) and date range, with progress notifications |
| `get_load` | own load model (TSS per activity from power, pace, heart rate or RPE, with the thresholds valid on each date): CTL/ATL/TSB, ACWR 7:28, monotony and strain, flags with overridable thresholds, ISO weeks per sport, 3-zone intensity split; optional daily series, per-activity TSS/IF/load source/EF and running dynamics, monthly EF trend, monthly running dynamics at a reference pace |
| `compare_activities` | sessions side by side (`ids`), or the ones similar to an activity (`similar_to`: same type, duration and pace, optionally same route or easy only): pace, GAP, HR, power (best 5 and 20 min once the power curve is stored), EF, decoupling, TSS, dynamics, weather |
| `get_readiness` | morning GO / MODIFY / REST from HRV, resting HR, sleep hours and load, with Garmin's Training Readiness, Body Battery, stress and sleep score shown, not counted; overridable `rules`, every signal with value, reference and rating |
| `get_thresholds`, `set_threshold` | threshold history per date (LTHR per sport, LT1, HRmax, FTP, VO2max...; Garmin profile changes and Garmin's own lactate threshold and FTP history recorded automatically), an FTP estimate from stored power curves (shown, not recorded), heart rate and power zones per sport from the Garmin profile, and recording a test result, locally only |

`delete_activity`, `delete_workout`, `delete_weigh_in`, overwriting a saved workout (`create_workout` with `workout_id`) and replacing the strength sets of an activity (`update_activity` with `exercise_sets`) are only available with `GARMIN_ENABLE_DESTRUCTIVE=true`.

Resources: `garmin://profile`, `garmin://gear`, `garmin://devices`, `garmin://activity-types`, `garmin://sync-status`, `garmin://today` (today's readiness decision, last night in one line and the workouts planned for today, from the local cache without downloading), `garmin://courses` (your courses with distance and elevation gain), `garmin://challenges` (how many badges you earned, the 10 latest and the challenges in progress with their progress), and the templates `garmin://activity/{id}`, `garmin://workout/{id}` and `garmin://course/{id}` (a course's profile in 20 stretches and its climbs) with id completion. Prompts: `weekly_review`, `plan_next_week`, `sleep_report` (a range of nights, then the worst one hour by hour), `activity_review` (one activity, then the sessions similar to it) and `race_check` (the next race, form and race predictions). Resources and prompts are not part of the tool list, so they add nothing to its context budget.

Every response is `{ data, meta: { source: cache|live|partial|local, fetched_at, coverage?, sync_hint? } }`, as JSON text and as `structuredContent` matching the tool's `outputSchema`; failures are `{ error: { code, message, hint } }`.

Formulas, defaults and limits of the analytics tools: [docs/analytics.md](docs/analytics.md). Which Garmin Connect data is covered, and what is still missing: [docs/coverage.md](docs/coverage.md).

## CLI

`garmin-mcp-cli` shares the core with the server and is handy for setup and checks:

```
garmin login [--strategy auto|browser|curl|fetch] [--email] [--token-path]
garmin import-tokens <file>          # garmin_tokens.json from python-garminconnect 0.3.x
garmin status [--json]
garmin sync [--scope ...] [--from --to] [--force] [--pause <s>]   # default: last 7 days
garmin activities [--from --to --type --limit --json]
garmin health <metric> [--from --to --week --json]
garmin load [--from --to] [--source auto|hrtss|garmin_load] [--flags <file.json>] [--series] [--activities] [--efficiency] [--by-sport] [--json]
garmin readiness [date] [--rules <file.json>] [--json]          # GO / MODIFY / REST for the morning
garmin thresholds [--date --param --history --json]             # LTHR, LT1, HRmax ... in effect, per sport
garmin thresholds add <date> <param> <value> [--source test|manual] [--note]
garmin thresholds export [--out <file.csv>]                     # date,param,value,source,note
garmin thresholds import <file.csv>
garmin import-activities <file.csv...>                          # Garmin Connect "Activities" CSV exports
garmin upload <file.fit|gpx|tcx...> [--json]                    # new activities to Garmin Connect
garmin course download <id> [--out <file|dir>] [--json]         # a course as GPX
garmin course upload <file.gpx> [--json]                        # a GPX file as a new course
garmin log weight <kg> [--fat <pct>] [--date] [--json]          # measurements to Garmin Connect; --date "YYYY-MM-DD HH:MM"
garmin log bp <systolic/diastolic> [--pulse --note --date --json]
garmin log water <ml> [--date] [--json]
garmin doctor                        # TLS strategy, hosts, permissions, tokens, SQLite driver
garmin serve [--transport stdio|streamable-http] [--port]
garmin logout
```

`load`, `readiness` and `thresholds` print the same results as the `get_load`, `get_readiness` and `get_thresholds` tools: markdown tables by default, the tool's `{ data, meta }` envelope with `--json`. They read the local database only and never download; missing days come back as a note with the `garmin sync` command that fills them. `import-activities` adds activities from Garmin Connect CSV exports (English or Polish headers) for dates the synced activities do not cover, and `thresholds export`/`import` keep a copy of the threshold history in a CSV file.

`upload` and `log` write to Garmin Connect. `upload` sends FIT, GPX or TCX files as new activities and prints each new activity's id; the activity goes into the local database at once. A file Garmin already has is reported as a duplicate and does not fail the command. `log` adds a weigh-in in kg, a blood pressure reading (`120/80`, optionally `--pulse` and `--note`) or water in ml to a day, now or at `--date` (a past day without a time is 12:00; nothing in the future). The MCP tools do not write these measurements: a reading tool would no longer be safe to call without asking. `course download` saves a course as a GPX file and `course upload` adds a GPX file as a new course.

Run it with `npx -y garmin-mcp-cli <command>` or install it globally (`npm i -g garmin-mcp-cli`).

## Signing in

The MCP server opens the same window by itself when a tool needs Garmin and nobody is signed in (no tokens yet, or Garmin no longer accepts them): the tool call waits up to 30 s for you, and when you need longer the assistant is told that the window is waiting and to ask again once you are done. This works over stdio, where the server runs on your computer, with a Chromium-based browser installed; `GARMIN_AUTO_LOGIN=false` turns it off, and then tools report `AUTH_NOT_LOGGED_IN` until you run `garmin login`.

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
| `GARMIN_ENABLE_DESTRUCTIVE` | `false` | delete tools, workout overwrite and strength set replacement |
| `GARMIN_AUTO_FETCH` | `true` | read tools download missing data themselves; `false`: only explicit syncs |
| `GARMIN_AUTO_LOGIN` | `true` | the server opens Garmin's sign-in page in your browser when nobody is signed in (stdio only); `false`: sign in with `garmin login` |
| `GARMIN_REDACT` | `true` | `get_activity` `full` leaves out name, profile/photo URLs, device and sensor serials and GPS; `false`: raw as sent |
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
