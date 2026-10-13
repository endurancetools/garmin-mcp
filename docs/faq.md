---
title: Frequently asked questions
description: "Garmin MCP FAQ: is it official, risks to your Garmin account, where your data goes, which watches, sports and AI clients work, cost, and uninstalling."
layout: faq
---
Short, honest answers. Each one points to the page with the details.

## Is Garmin MCP official?

No. Garmin MCP is an unofficial, open-source project, not affiliated with or endorsed by Garmin. Garmin and Garmin Connect are trademarks of Garmin Ltd. or its subsidiaries.

## Can my Garmin account get in trouble?

It might, and there is no guarantee either way. Garmin MCP signs in and reads data through the same unofficial endpoints that Garmin's own website and app use; Garmin does not offer them to third-party tools and can change, rate-limit or block them at any time. To stay gentle, it downloads only the days a question needs and never downloads a stored day again unless you force it. Long ranges go in 7-day chunks with a random 1-11 s pause, at most 600 requests a day, and a rate limit (HTTP 429) or a Cloudflare challenge pauses all downloads for 6 hours. A first sync of 90 days took 433 requests over about an hour on a real account. If you want to decide yourself when it downloads, set `GARMIN_AUTO_FETCH=false` ([Configuration](configuration.md)).

## Where does my data go?

Two places. Everything downloaded stays on your computer: tokens, the local database and settings live in `~/.garmin-mcp`, readable only by you ([what is stored where](how-it-works.md#what-is-stored-where)). The answers to your questions go to the AI client you connected, and the client sends them to the model provider it uses (Anthropic for Claude, OpenAI for Codex, and so on) as part of the conversation, under that provider's terms. The project runs no online service of its own and sends your data nowhere else. With the default browser sign-in your password never passes through the tool; the terminal fallback asks for it once and sends it only to Garmin's sign-in ([Signing in](sign-in.md)).

## Which watches and sports does it support?

Any device that syncs to Garmin Connect, because Garmin MCP reads your Garmin Connect account, not the watch. What you get depends on what your device records: HRV, for example, only comes from a watch that measures it overnight. Activities of every type are downloaded. Your own training load uses power for cycling, grade-adjusted pace for running, critical swim speed for swimming, and heart rate or your session RPE for everything else ([Load sources](analytics.md#load-sources)).

## Is this medical advice?

No. Readiness and training load are training information computed with methods from published sports-science literature, with citations. They say nothing certain about illness, injury or overtraining and do not replace a doctor or a coach. Each method and its limits are explained in [Methods and evidence](methods.md).

## What does it cost?

Nothing. Garmin MCP is free and open source under the MIT licence. You need a Garmin Connect account, and your AI client and its model may have their own price.

## Which AI clients does it work with?

The [getting started guides](getting-started.md) cover Claude Code, Claude Desktop (including a one-click extension), Codex, Antigravity CLI and opencode. Any other MCP client that can start a local command over stdio, or connect over streamable HTTP, uses the same settings ([Other clients](getting-started/other-clients.md)), but only the clients above have a guide. You also need Node.js 22 or newer on the computer that runs the server.

## Can it change or delete things in my Garmin account?

It can rename and edit activities, create workouts and put them on your calendar. A new workout is shown to you first and saved only after you agree. Deleting activities, workouts and weigh-ins ({{ site.data.facts.tools_destructive }} tools) and overwriting a saved workout are off unless you set `GARMIN_ENABLE_DESTRUCTIVE=true` yourself ([Tools reference](tools.md)).

## Can I check how the numbers are computed?

Yes. Every formula, default and limit is on [Training analytics](analytics.md), with {{ site.data.facts.references }} entries in its References list. Every answer from `get_load` and `get_readiness` returns the thresholds, flags and rules it used (`flags_used`, `rules_used`), and you can override them in the question.

## How do I uninstall it and delete my data?

1. Remove the server from your client: in Claude Code `claude mcp remove garmin --scope user` ([Claude Code](getting-started/claude-code.md#remove)); in Claude Desktop remove the Garmin extension, or the `garmin` entry from `claude_desktop_config.json`; in other clients delete the `garmin` entry from their configuration.
2. Sign out: `npx -y garmin-mcp-cli logout` deletes the stored tokens.
3. Delete the folder `~/.garmin-mcp` (or the one you set in `GARMIN_DATA_DIR`). That removes the local database, downloaded activity files and settings. With Docker, remove the volume instead (`docker volume rm garmin-data`).

Nothing is deleted from your Garmin Connect account.
