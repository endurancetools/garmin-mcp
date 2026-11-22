---
title: Tools reference
description: "Reference of every Garmin MCP tool for AI assistants: activities, sleep, HRV, training load and readiness, workouts and calendar, resources and prompts."
nav_order: 5
---
You do not need to call tools by name; the assistant does. This page tells you what exists.

| Tool | What it gives |
| --- | --- |
| `get_activities` | a dense list of activities with paging, with grade adjusted pace, cadence, normalized power, the Training Effect label and the temperature when the weather was downloaded; filter by date, Garmin type (`running`, `trail_running`, `cycling`, ...), event type (`race`, ...), duration in minutes, a pace range (`"4:45-5:30"`) and part of the name |
| `get_activity` | one activity: summary (with grade adjusted pace, running dynamics, breathing rate, stamina, Training Effect label, run/walk/stand time and heart rate source), splits with the same dynamics, lap intensity, workout step and how well it kept to the step target per lap, the laps summed per intensity (warmup, intervals, rests, cooldown), typed splits (run, walk, stand, ClimbPro climbs; run, walk and stand stretches under two minutes merged into a neighbour) with totals and shares per type, heart rate zones, power zones, weather, strength sets, the stream aggregated per kilometre, 5 minutes, half, quarter or climb (`stream_summary`, with Performance Condition; climbs with grade, VAM and W/kg), the power curve from the FIT file (best power for 1 s to 60 min in W and W/kg), or everything including the raw stream, optionally only some metrics and thinned out (without personal data and GPS unless `GARMIN_REDACT=false`) |
| `update_activity` | add a manual activity (type, local start, duration, optionally distance, name, notes, RPE, feel; private unless you choose otherwise); rename, change the type, the event type (race, training, recreation...), description, RPE, feel and privacy (public, followers for your connections, groups for your connections and groups, private); replace the strength sets (exercise, reps, weight; only with `GARMIN_ENABLE_DESTRUCTIVE=true`), optionally keeping the times the watch recorded, with the previous sets in the answer; put gear (shoes, a bike) on the activity or take it off, by name or uuid |
| `download_activity_file` | FIT, GPX, TCX, KML or CSV saved to your download folder |
| `query_health` | steps and daily distance, resting heart rate, HRV with status and baseline and the number of days per HRV status, sleep, stress, body battery, respiration, SpO2, intensity minutes, calories (burned, and eaten when a food log is linked), floors, hydration (water drunk, goal, sweat loss); per day or per week, with 7- and 28-day trends; per hour for up to 3 days with the peak and lowest hour and Body Battery events |
| `get_sleep` | one night with stages, or a range with averages |
| `get_training_status` | VO2max, training readiness, recovery time, Garmin's status, load and load focus, CTL/ATL/TSB from Garmin's training load (`garmin_load_model`), race predictions, endurance and hill scores, fitness age, personal records, heat and altitude acclimation |
| `get_body_composition` | weigh-ins with trend |
| `get_period_summary` | a week, a month or any range up to a year: volume per sport, heart rate zones, active and rest days, longest and hardest session, CTL/ATL/TSB from Garmin's training load at the end (`garmin_load_model`), health and energy averages, days per HRV status, change against the period before (from cached data only) |
| `list_workouts`, `get_workout` | your workout library, scheduled workouts, races and events (with the course of a race) in any date range, with readable steps |
| `create_workout`, `schedule_workouts` | build a workout from a preset (run intervals, walk/run, easy zone 2, strength circuit) or from typed steps with repeats and heart rate, pace or power targets; strength exercises are checked against Garmin's catalogue; `dry_run: true` shows the steps (with the exercise keys) and estimated duration before anything is saved; put it on the calendar or take it off |
| `get_gear`, `get_devices` | gear with distance, devices with firmware, last sync and settings, and for a solar watch the solar input of the last 7 days (downloaded again when older than an hour) |
| `garmin_sync` | download a scope (activities, health, training, reference or all) and date range explicitly, with progress |
| `get_load` | your own training load model from power, pace, heart rate or RPE: CTL/ATL/TSB (the form to ask about; [two load models](analytics.md#load-model)), ACWR, monotony and strain, warning flags, weekly volume per sport and of all sports with the TSS change, the range total with rest days, the longest break and the days since the last session, the CTL peak of the range, the 3-zone intensity split, optionally per-activity TSS with running dynamics, the efficiency trend and the monthly running dynamics at a reference pace ([formulas](analytics.md)) |
| `compare_activities` | chosen sessions side by side, or the sessions similar to one activity (same type, duration and pace, optionally the same route or easy runs only): pace, GAP, heart rate, power (with the best 5 and 20 minutes once the power curve is stored), EF, decoupling, TSS, running dynamics and weather in one table, each row with its difference from the first ([how they are matched](analytics.md#comparing-sessions)) |
| `get_readiness` | a morning GO / MODIFY / REST decision from HRV, resting heart rate, hours of sleep and load, with your own thresholds if you give them; Garmin's Training Readiness, Body Battery, stress and sleep score are shown, not counted; training information, not medical advice |
| `get_thresholds` | the thresholds in use on a date (LTHR and LT1 per sport, HRmax, 28-day resting heart rate) and their history, including Garmin's own lactate threshold (heart rate and pace) and FTP history with its dates, plus the heart rate and power zones per sport from your Garmin profile and an FTP estimate from your stored power curves ([how](analytics.md#ftp-estimate)), which is only recorded when you agree |
| `set_threshold` | record a field test result (LTHR, LT1, HRmax, FTP...) from a date; stored locally, never sent to Garmin |

With `GARMIN_ENABLE_DESTRUCTIVE=true` there are also `delete_activity`, `delete_workout`, `delete_weigh_in`, `create_workout` can overwrite a saved workout and `update_activity` can replace the strength sets of an activity.

## Resources and prompts

Resources the client can read directly: your profile, gear, devices, the list of activity type keys, your courses, your badges and challenges and the sync status; plus `garmin://activity/{id}`, `garmin://workout/{id}` and `garmin://course/{id}` for one item.

`garmin://course/{id}` describes a course before you ride or run it: distance, elevation gain and loss, the lowest and highest point, the profile in 20 stretches of equal length and the climbs (found as in `get_activity` with `bucket: "climbs"`). Positions are left out while `GARMIN_REDACT` is on. Courses are downloaded when read and kept for an hour; `list_workouts` adds the course of a race to its event.

`garmin://challenges` gives how many badges you earned and the 10 latest (date, points and how many times, for a badge earned more than once), and the badge challenges you joined that are still in progress, each with its start and end date and progress in %. The value and target of a challenge stay in Garmin's unit (`unit_id`), which Garmin does not name. It is downloaded when read (two requests, auto fetch on) and kept for an hour.

`garmin://today` is the morning at a glance: today's GO / MODIFY / REST decision from `get_readiness` with the rating of each signal, last night in one line (e.g. "23:13-06:48, 7 h 22 min, score 79 (fair), deep 0.8 h, REM 1.6 h, awake 0.2 h, 1 awakening, HRV 34 ms, resting HR 56 bpm") and the workouts on today's calendar. It is read from the local cache only and never downloads anything, so a client can attach it to every conversation; when something is missing, the note names the tool that downloads it (`get_readiness`, `get_sleep` or `list_workouts`).

Prompts are ready-made conversation starters some clients show in a menu (Claude Code lists them as `/mcp__garmin__<name>` commands):

| Prompt | Arguments | What it does |
| --- | --- | --- |
| `weekly_review` | `week_of` | reviews a training week (volume, intensity, recovery, form) and asks how it felt |
| `plan_next_week` | `goal`, `days_available` | proposes next week day by day and, once you approve, creates the workouts and puts them on the calendar |
| `sleep_report` | `from`, `to` | sleep over a range of nights (default the last 7), then the worst night hour by hour from its timeline |
| `activity_review` | `activity_id` | one activity (default the most recent) with its laps, then side by side with your similar sessions |
| `race_check` | `race` | the next race on your calendar, days left, form (CTL/ATL/TSB) and Garmin's race predictions, and what the remaining days should look like |

Every argument is optional. Resources and prompts are not part of the tool list, so they add nothing to the context the model reads with every message.

## Training analytics

How the five analytics tools, and the climbs and power curve of `get_activity`, compute their numbers, their defaults and their limits: [Training analytics](analytics.md).

## Which Garmin data is covered

[Coverage map](coverage.md): every Garmin Connect read and write, the tool that serves it, and what is still missing.
