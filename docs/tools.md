---
title: Tools reference
nav_order: 5
---
You do not need to call tools by name; the assistant does. This page tells you what exists.

| Tool | What it gives |
| --- | --- |
| `get_activities` | a dense list of activities with paging; filter by date and Garmin type (`running`, `trail_running`, `cycling`, ...) |
| `get_activity` | one activity: summary, splits, heart rate zones, power zones, weather, strength sets, or everything including the raw stream |
| `update_activity` | rename, change the type, description, RPE and feel |
| `download_activity_file` | FIT, GPX, TCX, KML or CSV saved to your download folder |
| `query_health` | steps and daily distance, resting heart rate, HRV with status and baseline, sleep, stress, body battery, respiration, SpO2, intensity minutes, calories, floors; per day or per week, with 7- and 28-day trends |
| `get_sleep` | one night with stages, or a range with averages |
| `get_training_status` | VO2max, training readiness, recovery time, Garmin's status, load and load focus, CTL/ATL/TSB from Garmin's training load (`garmin_load_model`), race predictions, endurance and hill scores, fitness age, personal records, heat and altitude acclimation |
| `get_body_composition` | weigh-ins with trend |
| `get_period_summary` | a week, a month or any range up to a year: volume per sport, heart rate zones, active and rest days, longest and hardest session, CTL/ATL/TSB from Garmin's training load at the end (`garmin_load_model`), health and energy averages |
| `list_workouts`, `get_workout` | your workout library, scheduled workouts, races and events in any date range, with readable steps |
| `preview_workout`, `create_workout`, `schedule_workouts` | build a workout from a preset (run intervals, walk/run, easy zone 2, strength circuit) or from typed steps with repeats and heart rate, pace or power targets; preview before saving; put it on the calendar or take it off |
| `get_gear`, `get_devices` | gear with distance, devices with firmware, last sync and settings |
| `garmin_sync` | download a scope (activities, health, training, reference or all) and date range explicitly, with progress |
| `get_load` | your own training load model from power, pace, heart rate or RPE: CTL/ATL/TSB (the form to ask about; [two load models](analytics.md#load-model)), ACWR, monotony and strain, warning flags, weekly volume per sport, the 3-zone intensity split, optionally per-activity TSS and the efficiency trend ([formulas](analytics.md)) |
| `get_readiness` | a morning GO / MODIFY / REST decision from HRV, resting heart rate, sleep, Body Battery, training readiness, stress and load, with your own thresholds if you give them |
| `get_thresholds` | the thresholds in use on a date (LTHR and LT1 per sport, HRmax, 28-day resting heart rate) and their history |
| `set_threshold` | record a field test result (LTHR, LT1, HRmax, FTP...) from a date; stored locally, never sent to Garmin |

With `GARMIN_ENABLE_DESTRUCTIVE=true` there are also `delete_activity`, `delete_workout`, `delete_weigh_in`, and `create_workout` can overwrite a saved workout.

## Resources and prompts

Resources the client can read directly: your profile, gear, devices, the list of activity type keys, and the sync status; plus `garmin://activity/{id}` and `garmin://workout/{id}` for one item.

Prompts: `weekly_review` and `plan_next_week`, ready-made conversation starters some clients show in a menu.

## Training analytics

How the four analytics tools compute their numbers, their defaults and their limits: [Training analytics](analytics.md).

## Which Garmin data is covered

[Coverage map](coverage.md): every Garmin Connect read and write, the tool that serves it, and what is still missing.
