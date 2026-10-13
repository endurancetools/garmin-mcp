---
title: "Methods and evidence: fitness, fatigue, form and HRV readiness"
description: "Plain-language guide to how Garmin MCP computes training load, fitness, fatigue and form, ACWR, intensity distribution and HRV readiness, with sources."
---
The training numbers in Garmin MCP (`get_load`, `get_readiness`) use methods from published sports-science literature, with citations. This page explains each one in plain words: what it tells you, which work it comes from, where it stops being reliable, and how to change its defaults. The formulas, defaults and exact rules are on one page only, [Training analytics](analytics.md); the numbers in square brackets below point to its [References](analytics.md#references).

**Not medical advice.** These are training metrics computed from what your watch recorded. They describe load and trends; they say nothing certain about illness, injury or overtraining, and they do not replace a doctor or a coach who knows you. If you feel unwell, talk to a doctor.

## Before anything else: your thresholds

Almost every number here is relative to your own thresholds: lactate threshold heart rate (LTHR), cycling FTP, running threshold pace, critical swim speed (CSS), and the first lactate threshold (LT1). They come from your Garmin profile and from the field tests you record with `set_threshold`, each with the date it applies from, so older sessions keep the thresholds of their time.

- **Limits.** A threshold that was never measured falls back to an estimate (for example LTHR from your maximum heart rate, or LT1 as a share of LTHR), and the answer says so. An outdated threshold shifts every number below in the same direction.
- **Change it.** Record a test result with `set_threshold` (or `garmin thresholds add`); `get_thresholds` shows which value is in use on a date and where it came from. See [Thresholds with history](analytics.md#thresholds-with-history).

## Training stress (TSS) and where it comes from

**What it tells you.** One number per session for how hard it was, on a common scale where an hour at your threshold is 100. Because every sport uses the same scale, a ride, a run and a swim add up in one daily total.

**Where it comes from.** Each session uses the best measurement it has, in the order TrainingPeaks ranks the measured sources, with your own rating last: power for rides (Training Stress Score) [[1]](analytics.md#references), grade-adjusted pace for runs (rTSS) [[13]](analytics.md#references), swim speed against CSS (sTSS) [[18]](analytics.md#references), heart rate (hrTSS, scored from time in heart-rate zones) [[15, 17]](analytics.md#references), and finally your own session rating of perceived exertion, RPE (session RPE) [[3, 16]](analytics.md#references). `load_source` of each activity says which one counted.

**Limits.**

- Heart rate lags behind short efforts and drifts up in the heat, so hrTSS reads low for intervals and strength work and high on hot days. That is why it comes after power and pace. Load measured inside the body (heart rate, RPE) and outside it (power, pace) answer different questions [[6]](analytics.md#references).
- Running stress uses Garmin's average grade-adjusted pace for the whole run, not a pace weighted second by second, so interval runs read a little low [[13, 14]](analytics.md#references).
- Swimming counts from speed only after you record a CSS; Garmin's profile has none.
- Session RPE is converted to the threshold scale with a fixed factor, an approximation that is not fitted to you. It counts only when nothing was measured.

**Change it.** `flags` of `get_load`: `{"hr_method": "avg"}` scores heart rate from the session average instead of zones, `{"rpe_calibration": 0.2}` changes the RPE factor. `source: "hrtss"` sums heart rate only, `source: "garmin_load"` uses Garmin's own training load. Details in [Load sources](analytics.md#load-sources) and [Load flags](analytics.md#load-flags).

## Fitness, fatigue and form (CTL, ATL, TSB)

**What it tells you.** Fitness (CTL) is your training stress averaged over about six weeks, fatigue (ATL) the same over about one week, and form (TSB) the difference between them. A falling TSB means you are training more than you are used to; a rising one means you are absorbing it or tapering.

**Where it comes from.** The fitness-fatigue model of Banister [[2]](analytics.md#references), in the form popularised for power and pace training as the Performance Management Chart [[1]](analytics.md#references).

**Limits.**

- It is a model of load, not a measurement of your body. Two people with the same CTL are not equally fit.
- It needs about 42 days of history to settle. Before that, fitness reads low and form looks deeply negative after ordinary training; the answer marks those days as `warming_up` and keeps the form flags off.
- One model covers every sport by default, but fitness carries over between sports only in part: a cycling block raises CTL without preparing your legs for a hard run. `include_by_sport: true` adds a separate model per sport group.
- Garmin's own load model in `get_training_status` uses Garmin's training load instead of TSS. The two never match in absolute numbers; compare their direction.

**Change it.** `flags` of `get_load`: `{"tsb_low": -25, "tsb_fresh": 10}` move the points where deep fatigue and freshness are flagged. See [Load model](analytics.md#load-model).

## Acute:chronic workload ratio (ACWR)

**What it tells you.** Your load of the last week compared with the last four weeks. Around 1 means you are doing what you are used to; well above 1 is a sudden jump; well below 1 is a taper, a break or undertraining.

**Where it comes from.** Research on training load and injuries, much of it in team sports [[4, 5]](analytics.md#references).

**Limits.** Read it as a warning about a sudden jump in load, nothing more. A critical review [[7]](analytics.md#references) points out conceptual and statistical problems with the ratio, among them that the last week is part of the four weeks it is divided by; it should not be used to predict injuries [[7]](analytics.md#references). The default cut-offs here are starting points to adjust, not fixed limits. After a break of more than about ten days the four-week average is low, so the ratio rises artificially on the first sessions back. With very little training (low CTL) it says little, and the low-ratio flag stays off.

**Change it.** `flags` of `get_load`: `{"acwr_high": 1.4, "acwr_warn": 1.25, "acwr_low": 0.7}`. See [Load flags](analytics.md#load-flags).

## Monotony and strain

**What it tells you.** Monotony shows how similar your days were over the last week: high monotony means every day carried about the same load, with no easy days in between. Strain combines the week's total load with its monotony.

**Where it comes from.** Foster's work on monitoring training and overtraining [[3]](analytics.md#references).

**Limits.** One rest day lowers monotony strongly, which is intended, because alternating hard and easy days is the point. Strain is most useful as a trend from week to week, not as a single value.

**Change it.** `flags` of `get_load`: `{"monotony_high": 2.5}`. See [Load flags](analytics.md#load-flags).

## Intensity distribution

**What it tells you.** How your endurance time over the last 28 days splits into three zones: easy (below LT1), moderate (between LT1 and threshold) and hard (above threshold). Many endurance athletes spend most of their time in the easy zone; the flag `z1_below_target` says when your easy share is lower than the target.

**Where it comes from.** Seiler's review of intensity distribution in endurance athletes [[8]](analytics.md#references).

**Limits.**

- The split is only as good as your LT1 and LTHR. With estimated thresholds it is an approximation.
- The heart-rate zones come from your Garmin profile as it is today, so after you change your zones, older sessions are split with the new bounds.
- By default only running, cycling, cross-country skiing and rowing count. In mountain weeks, long easy walks are left out, which can make the easy share look low.
- The target share is a common orientation point, not a rule for every athlete or every phase of a season.

**Change it.** `flags` of `get_load`: `{"z1_min_pct": 70}` changes the target, `{"intensity_sports": ["run", "bike", "nordic", "row", "hike"]}` adds hiking. Record a tested LT1 with `set_threshold` (`lt1_hr`). See [Intensity distribution](analytics.md#intensity-distribution).

## Efficiency and decoupling

**What it tells you.** The efficiency factor is how much speed or power you get per heartbeat in easy sessions; a rising trend at the same heart rate means better aerobic fitness. Decoupling compares the first and second half of one long, steady session: if your heart rate drifts up while your pace or power stays the same, the second half was less efficient. Around 5% is a usual orientation point.

**Where it comes from.** The efficiency factor and aerobic decoupling (Pa:Hr, Pw:Hr) as described for power and pace training [[1]](analytics.md#references); the ability to hold your physiology steady over long efforts, called durability [[20]](analytics.md#references).

**Limits.**

- Compare like with like: the same routes, terrain and conditions. Hills, walking breaks, wind, heat, stops and the warm-up all move the numbers.
- Efficiency is computed only from easy sessions (below LT1, at least 30 minutes), so it depends on your LT1.
- Decoupling needs the laps of the activity, downloaded with `get_activity` and `detail: "splits"`, at least 4 laps and at least 60 minutes; without them the field stays empty. It uses lap averages, so a ride with surges reads differently.
- Decoupling is shown as information, never as a warning flag.

**Change it.** `include_efficiency: true` in `get_load` adds the monthly trend; adding `hike` to `intensity_sports` brings hikes into it. See [Efficiency](analytics.md#efficiency) and [Decoupling](analytics.md#decoupling).

## Morning readiness

**What it tells you.** `get_readiness` answers "can I train hard today?" with GO, MODIFY or REST. It compares last night's HRV, your resting heart rate, your hours of sleep and your own training load with your own recent baselines. A rest day needs two independent warnings that agree (for example low HRV and a raised resting heart rate, or heavy load and a poor night); a single warning turns the day into MODIFY. Garmin's Training Readiness, Body Battery and stress are shown next to it but do not vote, because they are built from the same inputs.

**Where it comes from.** Day-to-day HRV-guided training, which compares each night with your own baseline rather than with population norms [[9, 11, 12]](analytics.md#references); resting heart rate read the same way [[10]](analytics.md#references); heavy load together with a physiological warning as the picture of overreaching described in the consensus on overtraining [[19]](analytics.md#references).

**Limits.**

- It reads your data, not how you feel. If you feel ill or injured, that matters more than any signal here.
- In the first four weeks the HRV and resting heart rate baselines are short and the comparison is weaker; in the first 42 days the load signal is unknown.
- One short or restless night moves several signals at once. The rule asks for agreement between signals for this reason, but it cannot fully separate them.
- On a race day the answer does not change the race plan.

**Change it.** `rules` of `get_readiness`: for example `{"sleep_h_yellow": 7.5}` if you need more sleep, `{"rhr_red_delta": 6}` for a noisier resting heart rate, or `{"decision_rule": "count"}` to count red and yellow signals instead of pairs. Every answer returns the rules it used in `rules_used`. See [Readiness rules](analytics.md#readiness-rules).
