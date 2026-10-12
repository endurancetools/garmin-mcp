---
title: Changelog
nav_order: 11
---
What changed in each release. All `garmin-mcp-*` packages share one version; the Claude Desktop extension of every version is attached to its [GitHub release](https://github.com/endurancetools/garmin-mcp/releases).

## 0.2.0 (2026-10-12)

### Training analytics

A new package, `garmin-mcp-analytics`, computes training metrics on your machine from the data already in the local database. Every formula, default and limit is described on the [Training analytics](analytics.md) page.

- **`get_load`**: an own load model. Each activity gets one training stress from the first source available: power (cycling, TSS), pace (running, rTSS), swim pace against CSS (sTSS), heart rate (hrTSS from the time in HR zones, else from average heart rate) or session RPE. From it: fitness, fatigue and form (CTL, ATL, TSB), ACWR, monotony and strain, weekly volume per sport, a three-zone intensity split against LT1 and LTHR, load flags, an optional form per sport and a monthly efficiency factor trend over aerobic sessions.
- **`get_readiness`**: a morning GO, MODIFY or REST decision from overnight HRV, resting heart rate, sleep, Body Battery, stress and load, each compared with your own recent baseline. Garmin's Training Readiness is shown next to it for reference and does not vote.
- **`get_thresholds`**: LTHR, LT1, HRmax, FTP, resting heart rate and the other thresholds in effect on a date, with their history, per-sport values, and the heart rate and power zones of every sport in the Garmin profile.
- **`set_threshold`**: record a field test result. Every metric is computed with the thresholds that applied on the activity's own date, so a new test changes the numbers from its date on.
- Thresholds start from the Garmin profile, which is downloaded before an analytics read when it is not stored yet. Without a tested value, documented approximations are used and the answer says so.
- Every flag and readiness rule can be overridden per call (`flags`, `rules`), and every answer returns the values it used.

### CLI

- `garmin load`, `garmin readiness` and `garmin thresholds` (`list`, `add`, `export`, `import`) give the same results in the terminal, as Markdown or `--json`. They never download; a missing range is reported with the `garmin sync` command to run.
- `garmin import-activities <file.csv...>` reads the Activities CSV export of Garmin Connect (English or Polish headers), so load history older than the synced range counts too. Imported activities count only on dates the synced activities do not cover.
- `garmin status` shows the number of stored thresholds and imported activities.

### Changed

- **`preview_workout` is merged into `create_workout`.** Call `create_workout` with `dry_run: true` to see the readable steps and the estimated duration without saving anything; the same input without `dry_run` saves the workout. The tool count stays at 20.
- `get_training_status` and `get_period_summary`: the CTL/ATL/TSB computed from Garmin's per-activity training load is now one field, `garmin_load_model` (formerly `computed_load` and `load_at_end`), and the descriptions say when to use it and when `get_load`.
- The server (`serverInfo.version`) and `garmin --version` report the version from `package.json` instead of a fixed `0.1.0`.

### Release

- The Claude Desktop extension `garmin-mcp-<version>.mcpb` is attached to every GitHub release.

## 0.1.1 (2026-10-12)

First public release: the MCP server, the `garmin` CLI and the Claude Desktop extension, on npm and in the MCP registry as `io.github.endurancetools/garmin-mcp`.

- 20 tools over a local SQLite cache: activities and activity files, daily health, sleep, training status, body composition, period summaries, gear, devices, the workout library and calendar, structured workouts and scheduling.
- Sign-in on Garmin's own page in your browser; only the tokens Garmin issues are stored. Missing days are downloaded on demand within a daily request limit.
- stdio and streamable HTTP transports, resources and two prompts (`weekly_review`, `plan_next_week`).
- Prebuilt `better-sqlite3` binaries instead of a native build, and tests passing on Linux, macOS and Windows.
