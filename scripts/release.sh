#!/usr/bin/env bash
# Release all garmin-mcp-* packages from this machine: changelog section, version bump, tag, GitHub
# release with the Claude Desktop extension, npm and the MCP registry. Every step checks whether it is
# already done, so after a failure the same command with the same exact version continues from there.
# Usage: pnpm release <x.y.z|patch|minor|major> [--dry-run]
#   --dry-run  run the checks only, change nothing
set -euo pipefail

# Pinned, with the SHA-256 of each archive from registry_<ver>_checksums.txt of
# https://github.com/modelcontextprotocol/registry/releases.
MCP_PUBLISHER_VERSION="1.8.1"
REGISTRY_SERVER="io.github.endurancetools/garmin-mcp"
REGISTRY_API="https://registry.modelcontextprotocol.io/v0/servers/${REGISTRY_SERVER//\//%2F}/versions"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mrelease: %s\033[0m\n' "$*" >&2; exit 1; }

dry_run=false
spec=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    -*) die "unknown option $arg" ;;
    *) [ -z "$spec" ] || die "one version only"; spec="$arg" ;;
  esac
done
[ -n "$spec" ] || die "usage: pnpm release <x.y.z|patch|minor|major> [--dry-run]"

current="$(node -p 'require("./apps/mcp-server/package.json").version')"
case "$spec" in
  patch | minor | major)
    version="$(node -e '
      const [major, minor, patch] = process.argv[1].split("-")[0].split(".").map(Number);
      const next = { major: [major + 1, 0, 0], minor: [major, minor + 1, 0], patch: [major, minor, patch + 1] };
      console.log(next[process.argv[2]].join("."));
    ' "$current" "$spec")"
    ;;
  *)
    [[ "$spec" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "not a version or keyword: $spec"
    version="$spec"
    ;;
esac
tag="v$version"
echo "Release $tag (packages are at $current)"

for tool in gh git node pnpm npm curl; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done
GITHUB_TOKEN="$(gh auth token 2>/dev/null)" || die "gh is not signed in: gh auth login"
export GITHUB_TOKEN

# The text of a `## <heading>` section without its heading line.
section() { awk -v v="$2" '/^## / { on = ($2 == v) } on' "$1" | sed 1d; }
has_text() { grep -q '[^[:space:]]'; }

git fetch --quiet --tags origin main

# ---------------------------------------------------------------------------------------------------
# 1-3. Checks, changelog and version: skipped when the tag already exists (a resumed release).
# ---------------------------------------------------------------------------------------------------
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  step "$tag exists, continuing an earlier release"
  [ "$current" = "$version" ] || die "packages are at $current, not $version: check out main at $tag"
  if $dry_run; then
    step "Dry run: the release continues from the GitHub release step, nothing changed"
    exit 0
  fi
else
  step "Checks"
  [ "$(git branch --show-current)" = main ] || die "not on main"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes: commit or stash them"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main differs from origin/main: pull or push first"
  node -e '
    const parse = (v) => v.split("-")[0].split(".").map(Number);
    const [a, b] = [parse(process.argv[1]), parse(process.argv[2])];
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    if (cmp <= 0) { console.error(`release: ${process.argv[1]} is not above ${process.argv[2]}`); process.exit(1); }
  ' "$version" "$current"

  for f in CHANGELOG.md docs/changelog.md; do
    if section "$f" "$version" | has_text; then
      echo "$f: section $version is ready"
    elif section "$f" Unreleased | has_text; then
      echo "$f: section Unreleased becomes $version"
    else
      die "$f has neither a '## $version' nor a filled '## Unreleased' section"
    fi
  done

  # The whole matrix (lint, typecheck, test, build on Linux, macOS and Windows) runs in CI on every push;
  # the release goes out only from a commit that passed it.
  head="$(git rev-parse HEAD)"
  run="$(gh run list --workflow CI --commit "$head" --event push --limit 1 \
    --json databaseId,status,conclusion -q '.[] | "\(.databaseId) \(.status) \(.conclusion)"')"
  [ -n "$run" ] || die "no CI run for ${head:0:7} (push it and wait for CI)"
  read -r run_id run_status run_conclusion <<<"$run"
  if [ "$run_status" != completed ]; then
    echo "Waiting for CI run $run_id on ${head:0:7}"
    gh run watch "$run_id" --exit-status >/dev/null || die "CI failed on ${head:0:7}: gh run view $run_id"
  elif [ "$run_conclusion" != success ]; then
    die "CI ended with '$run_conclusion' on ${head:0:7}: gh run view $run_id"
  fi
  echo "CI passed on ${head:0:7}"

  # Signed in before anything is tagged, so npm cannot stop the release halfway.
  if ! npm whoami >/dev/null 2>&1; then
    $dry_run && die "npm is not signed in: npm login"
    npm login --auth-type=web
  fi
  echo "npm: signed in as $(npm whoami)"

  if $dry_run; then
    step "Dry run: checks passed, nothing changed"
    exit 0
  fi

  step "Changelog and server.json for $version"
  today="$(date +%F)"
  for f in CHANGELOG.md docs/changelog.md; do
    section "$f" "$version" | has_text || perl -pi -e "s/^## Unreleased\$/## $version ($today)/ && (\$done = 1) unless \$done" "$f"
  done
  # server.json carries the version of the npm package the MCP registry entry points to.
  node -e '
    const fs = require("node:fs");
    const server = JSON.parse(fs.readFileSync("server.json", "utf8"));
    server.version = process.argv[1];
    for (const p of server.packages) if (p.identifier === "garmin-mcp-server") p.version = process.argv[1];
    fs.writeFileSync("server.json", JSON.stringify(server, null, 2) + "\n");
  ' "$version"
  git add CHANGELOG.md docs/changelog.md server.json
  git diff --cached --quiet || git commit --quiet -m "chore(release): prepare $version"

  step "Version, tag and GitHub release (nx release)"
  pnpm install --frozen-lockfile
  # Bumps every package.json, commits "chore(release): publish <version>", tags, pushes main with the
  # tag and creates the GitHub release (GITHUB_TOKEN); preVersionCommand builds everything first.
  pnpm nx release "$version" --skip-publish
fi

# ---------------------------------------------------------------------------------------------------
# 4. GitHub release: notes from CHANGELOG.md and the Claude Desktop extension.
# ---------------------------------------------------------------------------------------------------
step "GitHub release notes and Claude Desktop extension"
[ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ] || git push --atomic origin main "$tag"
notes="$(mktemp)"
trap 'rm -f "$notes"' EXIT
section CHANGELOG.md "$version" >"$notes"
has_text <"$notes" || die "CHANGELOG.md has no '## $version' section"
if gh release view "$tag" >/dev/null 2>&1; then
  gh release edit "$tag" --notes-file "$notes" >/dev/null
else
  gh release create "$tag" --verify-tag --title "$tag" --notes-file "$notes" >/dev/null
fi
./scripts/build-mcpb.sh
# The fixed name lets releases/latest/download/garmin-mcp.mcpb on the docs site serve the newest one.
cp "dist/garmin-mcp-$version.mcpb" dist/garmin-mcp.mcpb
gh release upload "$tag" "dist/garmin-mcp-$version.mcpb" dist/garmin-mcp.mcpb --clobber

# ---------------------------------------------------------------------------------------------------
# 5. npm: from this machine, because npm takes new packages only through a staged publish approved
# with 2FA. pnpm rewrites workspace:* to the released versions when it packs and skips packages whose
# version is already on npm.
# ---------------------------------------------------------------------------------------------------
step "npm"
packages=()
for manifest in apps/*/package.json packages/*/package.json; do
  name="$(node -p "const p = require('./$manifest'); p.private ? '' : p.name")"
  [ -n "$name" ] && packages+=("$name")
done
missing=()
for name in "${packages[@]}"; do
  [ -n "$(npm view "$name@$version" version 2>/dev/null)" ] || missing+=("$name")
done
if [ ${#missing[@]} -eq 0 ]; then
  echo "All ${#packages[@]} packages are on npm at $version"
else
  echo "To publish: ${missing[*]}"
  npm whoami >/dev/null 2>&1 || npm login --auth-type=web
  pnpm nx run-many -t build
  pnpm -r publish --access public --no-git-checks
  # A new package waits for approval on npmjs.com, and the registry shows new versions with a delay.
  for name in "${packages[@]}"; do
    for _ in $(seq 60); do
      [ -n "$(npm view "$name@$version" version 2>/dev/null)" ] && break
      echo "Waiting for $name@$version on npm"
      sleep 15
    done
    [ -n "$(npm view "$name@$version" version 2>/dev/null)" ] || die "$name@$version is not on npm after 15 minutes: approve a staged publish on npmjs.com, then run again"
  done
  echo "All ${#packages[@]} packages are on npm at $version"
fi

# ---------------------------------------------------------------------------------------------------
# 6. MCP registry: needs the npm version. The organization namespace needs a token with read:org.
# ---------------------------------------------------------------------------------------------------
step "MCP registry"
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$REGISTRY_API/$version")" = 200 ]; then
  echo "$REGISTRY_SERVER $version is already in the registry"
else
  [ "$(node -p 'require("./server.json").version')" = "$version" ] || die "server.json is not at $version"
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=darwin_arm64 sha=e45e520892460732a4bdf37255576415d4a53ec171f8b913faf15bb1aef7cb77 ;;
    Darwin-x86_64) platform=darwin_amd64 sha=88126981225e7714fcc6b7a10cdba4a80ae5901e9740a8c06d0d5195c8bc294c ;;
    Linux-x86_64) platform=linux_amd64 sha=a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc ;;
    *) die "no pinned mcp-publisher for $(uname -s) $(uname -m)" ;;
  esac
  bin_dir="$ROOT/node_modules/.cache/mcp-publisher/$MCP_PUBLISHER_VERSION"
  if [ ! -x "$bin_dir/mcp-publisher" ]; then
    mkdir -p "$bin_dir"
    archive="$bin_dir/mcp-publisher.tar.gz"
    curl -fsSL -o "$archive" "https://github.com/modelcontextprotocol/registry/releases/download/v$MCP_PUBLISHER_VERSION/mcp-publisher_$platform.tar.gz"
    echo "$sha  $archive" | shasum -a 256 -c - >/dev/null || { rm -f "$archive"; die "mcp-publisher checksum mismatch"; }
    tar xzf "$archive" -C "$bin_dir" mcp-publisher
    rm -f "$archive"
  fi
  gh auth status 2>&1 | grep -q "read:org" || die "the gh token lacks read:org: gh auth refresh -s read:org"
  "$bin_dir/mcp-publisher" login github --token "$GITHUB_TOKEN"
  "$bin_dir/mcp-publisher" publish
fi

step "Released $tag"
echo "GitHub: $(gh release view "$tag" --json url -q .url)"
echo "npm:    https://www.npmjs.com/package/garmin-mcp-server/v/$version"
echo "MCP:    $REGISTRY_API/$version"
