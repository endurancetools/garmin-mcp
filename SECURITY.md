# Security policy

Garmin MCP runs on your own computer and keeps your Garmin data there. This page says what it stores, how that is protected, and how to report a vulnerability.

## Supported versions

Only the latest release on npm (`garmin-mcp-server`, `garmin-mcp-cli`) and the matching `.mcpb` from [GitHub Releases](https://github.com/endurancetools/garmin-mcp/releases) receive fixes. Update before reporting, if you can.

## What is stored, and where

Everything lives in one data directory, `~/.garmin-mcp` by default (`GARMIN_DATA_DIR` changes it):

| File | Contents |
| --- | --- |
| `tokens.json` | Garmin OAuth tokens (`di_token`, `di_refresh_token`, `di_client_id`). They give access to the whole Garmin Connect account for months; treat them like a password. |
| `account.json` | the signed-in account: display name, full name and a short hash that names the database file |
| `garmin-<account>.db` | the local SQLite cache: activities, daily health, sleep, training status, workouts, calendar, gear, devices, threshold history, imported activities. This is health data. |
| `downloads/` | activity files you asked to download (FIT, GPX, ...) |
| `config.json` | optional settings |

What is never stored: your Garmin password. It is used once, during sign-in, and is not written to disk, logs, the database or error messages. Logs mask `Authorization` headers.

## Protection

- The data directory is created with mode `0700`; tokens and the database are written as `0600` (tokens atomically: a private temporary file, then rename).
- The server and the CLI refuse to start when the directory, `tokens.json` or the database is readable by group or others, and print the `chmod` command that fixes it. On Windows, POSIX modes do not apply and this check is skipped.
- Over stdio (the default), the server has no network listener. The optional HTTP transport refuses to bind to anything but localhost without `GARMIN_MCP_HTTP_TOKEN`, and rejects requests whose `Host` or `Origin` is not localhost or listed in `GARMIN_HTTP_ALLOWED_HOSTS` (DNS rebinding).
- The project sends no telemetry. Network traffic goes only to Garmin Connect. Answers that the server returns to your MCP client are sent by that client to the model provider it uses; that is outside this project.
- Tests and CI never contact Garmin; recorded fixtures are anonymized.

## Reporting a vulnerability

Please report privately, not in a public issue:

1. Open [Report a vulnerability](https://github.com/endurancetools/garmin-mcp/security/advisories/new) (GitHub Security Advisories, under the repository's **Security** tab).
2. Describe the problem, the affected version, and steps to reproduce.

Never include real tokens, the contents of `tokens.json`, your database or your Garmin password, not even in a private report; redacted examples are enough.

Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## Out of scope

- Garmin Connect itself, its sign-in or its rate limits: report those to Garmin.
- Anyone with access to your user account on your computer: they can read your files, including these.
- What the model provider of your MCP client does with the answers it receives.
