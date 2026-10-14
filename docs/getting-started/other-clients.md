---
title: "Connect Garmin to Codex, opencode and other MCP clients"
description: "Use the Garmin MCP server with Codex, Antigravity CLI, opencode, Docker or any MCP client over stdio or streamable HTTP, with configuration examples."
parent: Getting started
nav_order: 3
---
Sign in to Garmin first if you have not ([Getting started](../getting-started.md)). Every MCP client needs the same thing: run the command `npx` with the arguments `-y garmin-mcp-server` over stdio.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.garmin]
command = "npx"
args = ["-y", "garmin-mcp-server"]
```

## Antigravity CLI

```bash
agy mcp add garmin npx -y garmin-mcp-server
```

Inside `agy`, `/mcp list` shows `garmin`. The model reads the tool descriptions from files Antigravity keeps under `~/.gemini/antigravity-cli/mcp/garmin/` and calls them through its generic MCP tool.

## opencode

In `opencode.json`:

```json
{
  "mcp": {
    "garmin": {
      "type": "local",
      "command": ["npx", "-y", "garmin-mcp-server"],
      "enabled": true
    }
  }
}
```

## Any other client

Use these values wherever the client asks for an MCP server:

| Field | Value |
| --- | --- |
| Transport | stdio |
| Command | `npx` |
| Arguments | `-y garmin-mcp-server` |
| Environment (optional) | see [Configuration](../configuration.md) |

The server speaks the current MCP protocol (2026-07-28) and the 2025 revisions, so older clients connect unchanged.

## Over the network (streamable HTTP)

For a client on another machine, or one that only speaks HTTP, run the server with a token:

```bash
GARMIN_MCP_TRANSPORT=streamable-http GARMIN_MCP_HTTP_TOKEN=<secret> npx -y garmin-mcp-server
```

It serves `POST http://127.0.0.1:8000/mcp` and expects `Authorization: Bearer <secret>`. Without a token it only listens on 127.0.0.1. Behind a public hostname add it to `GARMIN_HTTP_ALLOWED_HOSTS=mcp.example.com`; requests with any other `Host` or `Origin` get 403. Put it behind HTTPS (a reverse proxy) before exposing it.

## Docker

```bash
docker build -t garmin-mcp https://github.com/endurancetools/garmin-mcp.git
docker run -it -v garmin-data:/data garmin-mcp login     # once, in the terminal (no browser inside the container)
docker run -i  -v garmin-data:/data garmin-mcp           # stdio server
```
