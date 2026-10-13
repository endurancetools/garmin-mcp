---
title: "Garmin Connect in Claude Code"
description: "Add the Garmin MCP server to Claude Code with one command, check it with /mcp, and ask Claude about your Garmin Connect training, sleep and recovery."
parent: Getting started
nav_order: 1
---
Sign in to Garmin first if you have not ([Getting started](../getting-started.md)).

## Add the server

In a terminal:

```bash
claude mcp add garmin --scope user -- npx -y garmin-mcp-server
```

`--scope user` makes the server available in every project. Leave it out to add it only to the current folder.

## Check it

Start `claude` and type `/mcp`. The list shows `garmin` as connected with {{ site.data.facts.tools_default }} tools. The first start takes a moment while `npx` downloads the package.

## Try it

```
How did I sleep this week?
Review my training week.
When is my next race?
Build me 6×400 m with 90 s rest and show me the steps.
```

When you ask for a workout, Claude shows the steps and waits for your go-ahead before saving anything to Garmin Connect.

## Settings you may want

Claude Code passes environment variables to the server with `--env`:

```bash
claude mcp add garmin --scope user --env GARMIN_ENABLE_DESTRUCTIVE=true -- npx -y garmin-mcp-server
```

- `GARMIN_ENABLE_DESTRUCTIVE=true` turns on deleting activities, workouts and weigh-ins and overwriting saved workouts. Off by default.
- `GARMIN_AUTO_FETCH=false` stops the server from downloading on its own; Claude then asks you before fetching missing days.

All options: [Configuration](../configuration.md).

## Remove

```bash
claude mcp remove garmin --scope user
```
