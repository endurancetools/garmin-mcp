---
title: Changelog
description: "Garmin MCP release notes: what changed in each version of the MCP server, CLI and Claude Desktop extension, including training analytics in 0.2.0 and the readiness pairs rule in 0.3.0."
nav_order: 11
---
What changed in each release. All `garmin-mcp-*` packages share one version; the Claude Desktop extension of every version is attached to its [GitHub release](https://github.com/endurancetools/garmin-mcp/releases).

## Unreleased

### Activities

- **An activity deleted in Garmin Connect disappears from the local cache too.** Before, a sync only added and updated activities, so one deleted in Connect stayed in `get_activities` and the analytics until it was removed by hand. Now, once a sync has the whole activity list of a range, a stored activity of that range missing from the list is checked with Garmin and removed when Garmin answers 404 for it; any other answer keeps it, and a list that fails part way removes nothing. More than 20 such activities in one list are taken for a bad list and none is removed. The list of today and yesterday is fetched again when it is older than 15 minutes, so a recent deletion goes with the next read or sync; for an older one run `garmin sync --scope activities --from <date> --to <date> --force`. `garmin sync` and `garmin_sync` report the removals (`removed`). This mirrors your account and needs no `GARMIN_ENABLE_DESTRUCTIVE`: nothing is deleted in Garmin Connect.
- **`get_activity` on an activity deleted in Garmin Connect** removes it from the cache and says so, instead of a bare 404, when it has to ask Garmin for a section it has not stored yet.

### Races in the calendar

- **Calendar months that are not over yet go stale after 15 minutes instead of an hour,** like today's health data. A race added or moved in Garmin Connect shows up in `list_workouts` at most 15 minutes later, through the automatic sync; months fetched after they ended stay final.

## 0.4.1 (2026-10-16)

### Races in the calendar

- **Races from Garmin's event catalogue show up in `list_workouts`.** Garmin sends a race added from its event search with no calendar id, only an event uuid; such races were skipped, so `upcoming_events` missed them. Calendar events are now keyed by the calendar id or, without one, by the event uuid (database schema 7). The upgrade drops the list of cached calendar months, so the next `list_workouts` fetches them again.
- **A race added to a future month appears without a manual sync.** A calendar month that is not over yet goes stale after an hour, as before, but a read now treats it as missing too, so `list_workouts` refreshes it through the automatic sync (`GARMIN_AUTO_FETCH`). Before, a month fetched once was never fetched again by a read, and a race added later stayed invisible until `garmin sync --scope reference --force`.

## 0.4.0 (2026-10-15)

### Health metrics

- **Calories eaten.** `query_health` with `metrics: ["calories"]` and `garmin health calories` return `calories_consumed_kcal` next to the calories burned: the day's total from a food log linked to Garmin Connect (e.g. MyFitnessPal), averaged over the days with entries in a weekly table. Days without food entries leave the field out, never 0. Garmin already sent the value with the daily summary, so days synced before this version have it without downloading them again; food logged after a past day was stored (it is not refreshed once the day is over) needs `garmin sync --scope health --from <date> --to <date> --force`.

## 0.3.1 (2026-10-14)

### Morning readiness

- The `load` signal names its source: `source: "hrtss"` in its value and "Own load (hrtss)" in its detail. It sums heart-rate stress only, so its TSB and ACWR differ from the default `get_load` (power, then pace, then heart rate) after sessions where pace understates the effort, such as mountain races with long walking climbs.

## 0.3.0 (2026-10-13)

### Claude Desktop extension

- The extension is called **Garmin MCP** in Claude Desktop, not "Garmin Connect", which is Garmin's own service. Its description says it is an unofficial, open-source server, not affiliated with Garmin.
- Every release also carries the extension as `garmin-mcp.mcpb`, so `releases/latest/download/garmin-mcp.mcpb` always downloads the newest one.

### Morning readiness

- **REST needs two signals that agree.** By default (`decision_rule: "pairs"`) the decision is REST only when both signals of a pair are red: HRV with resting heart rate, HRV with sleep, or load with HRV, resting heart rate or sleep. A single red signal gives MODIFY. One short night lowers HRV, raises resting heart rate and shortens sleep together, so the old counting rule could cancel a key session on one event. `rules: {"decision_rule": "count"}` restores it.
- **The decision uses HRV, resting heart rate, sleep hours and load only.** Sleep is rated by hours; the sleep score stays in the answer. Body Battery and stress are shown for reference (`info`), like Garmin's Training Readiness, and do not vote. The rules `sleep_score_red`, `sleep_score_yellow`, `bb_red`, `bb_yellow` and `stress_yellow` are gone and are ignored with a note.

### Training load

- **Aerobic decoupling** (Pa:Hr for running, Pw:Hr for power) per session in `get_load` activities, and its monthly mean in the efficiency trend: the efficiency of the first and second half of a steady session of at least an hour, from the laps of the activity.
- **`flags.intensity_sports`** chooses which sport groups the intensity distribution counts (default run, bike, nordic, row). Add `hike` to include mountain walking; it then also gets an efficiency trend from grade adjusted speed.

### Documentation

- New pages: [Methods and evidence](methods.md) (what fitness, fatigue, form and HRV readiness mean and where the methods come from) and an [FAQ](faq.md).
- Every npm package has its own README; `SECURITY.md`, `CONTRIBUTING.md` and issue and pull request templates in the repository.

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
