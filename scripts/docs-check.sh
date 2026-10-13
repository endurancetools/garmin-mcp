#!/usr/bin/env bash
# Check links, images and scripts in the built documentation site (docs/_site, from `pnpm docs:build`)
# with html-proofer inside the same ruby:3.3 image the preview uses. Internal links only by default;
# `external` also requests every external URL.
# Usage: scripts/docs-check.sh [external]
set -euo pipefail
cd "$(dirname "$0")/../docs"
if [ ! -f _site/index.html ]; then
  echo "docs/_site is missing; run pnpm docs:build first" >&2
  exit 1
fi
# The site lives under /garmin-mcp/, so absolute links to it are checked as files in _site.
args=(--swap-urls '^https\://endurancetools\.github\.io/garmin-mcp/:/,^/garmin-mcp/:/,^/garmin-mcp$:/'
  --checks Links,Images,Scripts,OpenGraph,Favicon --no-enforce-https)
if [ "${1:-}" = "external" ]; then
  # npmjs.com (403) and LinkedIn (999) refuse non-browser requests; the package is checked with
  # `npm view` instead, the profile by hand.
  args+=(--ignore-urls '/^https:\/\/www\.npmjs\.com\//,/^https:\/\/www\.linkedin\.com\//')
else
  args+=(--disable-external)
fi
exec docker run --rm \
  -v "$PWD/_site:/site:ro" \
  -v garmin-mcp-htmlproofer-gems:/usr/local/bundle \
  ruby:3.3 bash -c "(gem list -i html-proofer -v 5.0.10 >/dev/null || gem install html-proofer -v 5.0.10 --no-document --silent) && htmlproofer /site $(printf "'%s' " "${args[@]}")"
