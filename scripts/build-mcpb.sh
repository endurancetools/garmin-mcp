#!/usr/bin/env bash
# Build the Claude Desktop extension. The manifest launches the published npm
# package through npx, so the bundle carries no native modules.
set -euo pipefail
# Pinned: a schema change in a newer mcpb must not slip in unnoticed.
MCPB_VERSION="2.1.2"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/apps/mcp-server/package.json').version")"
OUT="$ROOT/dist/garmin-mcp-$VERSION.mcpb"
mkdir -p "$ROOT/dist"
TMP="$(mktemp -d)"
node -e "
const m = require('$ROOT/mcpb/manifest.json');
m.version = '$VERSION';
m.server.mcp_config.args = ['-y', 'garmin-mcp-server@$VERSION'];
require('fs').writeFileSync('$TMP/manifest.json', JSON.stringify(m, null, 2));
"
npx -y "@anthropic-ai/mcpb@$MCPB_VERSION" validate "$TMP/manifest.json"
rm -f "$OUT"
(cd "$TMP" && zip -q "$OUT" manifest.json)
rm -rf "$TMP"
echo "Built $OUT"
