#!/usr/bin/env bash
# Serve docs/ locally at http://localhost:4000/garmin-mcp/ with live reload, using the GitHub Pages
# gem set inside Docker. Gems are cached in a named volume, so only the first run installs them.
# Usage: scripts/docs-serve.sh [build]   (`build` writes docs/_site once and exits)
set -euo pipefail
cd "$(dirname "$0")/../docs"
cmd="jekyll serve --host 0.0.0.0 --port 4000 --livereload --livereload-port 35729 --incremental"
if [ "${1:-}" = "build" ]; then cmd="jekyll build"; fi
exec docker run --rm -it \
  -p 4000:4000 -p 35729:35729 \
  -v "$PWD:/site" -w /site \
  -v garmin-mcp-docs-gems:/usr/local/bundle \
  -e JEKYLL_ENV=development -e PAGES_REPO_NWO=endurancetools/garmin-mcp \
  ruby:3.3 bash -c "bundle config set --local path /usr/local/bundle >/dev/null && (bundle check >/dev/null 2>&1 || bundle install --quiet) && bundle exec $cmd"
