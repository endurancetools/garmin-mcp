---
title: Claude Desktop
parent: Getting started
nav_order: 2
---
Sign in to Garmin first if you have not ([Getting started](../getting-started.md)).

## Option A: install the extension

1. Download `garmin-mcp-<version>.mcpb` from the [latest release](https://github.com/endurancetools/garmin-mcp/releases/latest).
2. Open the file. Claude Desktop asks whether to install the "Garmin" extension; confirm.
3. In the extension settings you can switch **Download missing data automatically** off if you want Claude to ask before fetching. It is on by default.

The extension runs `npx -y garmin-mcp-server` for you, so Node.js 22 or newer still has to be installed.

## Option B: edit the configuration file

Open Claude Desktop → Settings → Developer → **Edit Config**. That opens `claude_desktop_config.json`; add the `garmin` entry:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "npx",
      "args": ["-y", "garmin-mcp-server"]
    }
  }
}
```

To change a setting, add an `env` block, for example:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "npx",
      "args": ["-y", "garmin-mcp-server"],
      "env": { "GARMIN_AUTO_FETCH": "false" }
    }
  }
}
```

## Restart and check

Quit Claude Desktop completely (menu Claude → Quit) and start it again. In a new conversation, the tools icon next to the message box lists `garmin` with 21 tools.

If `npx` is not found, Claude Desktop does not see your shell's PATH. Put the full path to `npx` in `command` (run `which npx` in a terminal to find it), or install Node.js with the official installer.

## Try it

```
Summarise my last training week.
How did my HRV and resting heart rate trend over the summer?
What is planned for this week?
```

## Troubleshooting

Settings → Developer → **Open Logs Folder** contains `mcp-server-garmin.log` with the server's messages. See [Troubleshooting](../troubleshooting.md).
