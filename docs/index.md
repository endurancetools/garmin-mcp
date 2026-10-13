---
title: "Garmin MCP – Garmin Connect for Claude and AI assistants"
description: "Unofficial open-source Garmin MCP server: ask Claude or any AI assistant about your training load, form and HRV readiness, and send workouts to your watch."
layout: splash
nav_order: 1
excerpt: "Training load, form and morning readiness from your Garmin Connect data, computed on your machine with cited sports-science methods. Unofficial and open source; not affiliated with Garmin."
header:
  # The hero headline (E7-2a); `title` above is the page title in search results and link previews.
  title: "Ask your AI assistant how your training is really going"
  overlay_color: "#1d3557"
  actions:
    - label: "Get started"
      url: /getting-started/
    - label: "Install for Claude Desktop"
      url: https://github.com/endurancetools/garmin-mcp/releases/latest
feature_row:
  - title: "Answers you can check"
    excerpt: "Load, form and morning readiness worked out with methods from published sports-science literature, with citations. Every answer shows the values and rules it used, and you can change them to fit you."
    url: /methods/
    btn_label: "Methods and evidence"
    btn_class: "btn--primary"
  - title: "One question, one answer"
    excerpt: "Built around what athletes ask, like “review my week” or “can I train hard today?”, so the assistant answers in one step instead of piecing raw data together."
    url: /how-it-works/#designed-tools
    btn_label: "Designed tools"
    btn_class: "btn--primary"
  - title: "Local and private"
    excerpt: "You sign in on Garmin's own page, so your password never passes through the tool. What it downloads stays on your computer, answers come back in milliseconds, and downloads are paced to stay gentle with Garmin."
    url: /how-it-works/#what-is-stored-where
    btn_label: "What is stored where"
    btn_class: "btn--primary"
  - title: "From answer to watch"
    excerpt: "Ask for “6×400 m with 90 s rest on Thursday”: you see the steps first, nothing is saved until you agree, and then it goes to your Garmin calendar and syncs to the watch."
    url: /asking/#workouts-and-calendar
    btn_label: "Workouts and calendar"
    btn_class: "btn--primary"
---

<div class="pillars">
{% include feature_row %}
</div>

<!-- Screenshot or GIF of a conversation goes here (E7-8, E7-3a). -->

## Can I train hard today? Ask Claude, with your Garmin data

One question, one `get_readiness` call. The assistant gets a decision built from your own HRV, resting heart rate, sleep and training load against your own recent baselines, and explains it. The numbers below are an example.

> **You:** Can I train hard today?
>
> **Claude:** **MODIFY.** Last night's HRV was 48 ms, below your usual range (52–64 ms), and you slept 6.4 hours. Your resting heart rate (47 bpm) and your training load are normal for you. Two yellow signals and no red pair, so there is no reason to skip the session: keep its structure but cut the hard part by a third (fewer reps, not a slower pace), or swap it with tomorrow's easy run. Garmin's Training Readiness says 58 (moderate); it is shown for comparison and does not vote.

<details markdown="1">
<summary>What <code>get_readiness</code> returned (shortened)</summary>

```json
{
  "date": "2026-10-13",
  "decision": "MODIFY",
  "counts": { "ok": 2, "yellow": 2, "red": 0, "info": 3, "unknown": 0 },
  "signals": [
    { "name": "hrv", "rating": "yellow", "value": { "last_night_ms": 48 },
      "reference": { "garmin_baseline_low_ms": 52, "garmin_baseline_high_ms": 64 },
      "detail": "HRV 48 ms below the baseline low 52 ms." },
    { "name": "rhr", "rating": "ok", "value": { "bpm": 47 }, "reference": { "mean28_bpm": 46.2 } },
    { "name": "sleep", "rating": "yellow", "value": { "hours": 6.4, "score": 61 }, "detail": "Sleep 6.4 h < 7 h." },
    { "name": "training_readiness", "rating": "info", "value": { "score": 58, "level": "MODERATE" } },
    { "name": "load", "rating": "ok", "value": { "tsb": -8, "acwr": 1.1 } }
  ],
  "recommendation": [
    "MODIFY: 2 yellow (hrv, sleep), at least decision_yellow_min 2.",
    "Keep the session structure, cut the quality part by 30-50% (fewer reps, not a slower pace) or swap it with an easy day."
  ]
}
```

Every threshold in `rules_used` can be changed ([Morning readiness](methods.md#morning-readiness)). Training information, not medical advice.
</details>

## Works with your assistant

- [Claude Code](getting-started/claude-code.md)
- [Claude Desktop](getting-started/claude-desktop.md): one-click extension or one line of configuration
- [Codex, Antigravity CLI, opencode](getting-started/other-clients.md)
- [Any other MCP client](getting-started/other-clients.md#any-other-client), over stdio or streamable HTTP, or from the Docker image

The server has {{ site.data.facts.tools_default }} tools and costs the model about {{ site.data.facts.tool_tokens }} tokens of context; in the last tool-choice evaluation the assistant picked the right one in {{ site.data.facts.eval_pass }} of {{ site.data.facts.eval_total }} questions ([how it works](how-it-works.md#designed-tools)).

## Three steps

1. **Sign in to Garmin once.** A browser window opens Garmin's own sign-in page; only the tokens Garmin issues are kept on your machine.
2. **Add the server to your client.** One command or one line of configuration ([Getting started](getting-started.md)).
3. **Ask.** "How did I sleep this week?", "Review my training week", "When is my next race?", "Build me 6×400 m for Thursday". More in [what you can ask](asking.md).

## What it does not do

- It never sees your Garmin password. The sign-in happens on Garmin's page in your browser.
- It never sends your data anywhere except to the AI client you connect it to.
- It never deletes anything unless you turn destructive tools on yourself ([configuration](configuration.md)).
