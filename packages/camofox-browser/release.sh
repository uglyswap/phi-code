#!/usr/bin/env bash
set -euo pipefail

# Release script for @phi-code-admin/camofox-browser
# Usage: ./release.sh [patch|minor|major]
# Defaults to patch if no argument given.
#
# This script:
#   1. Runs pre-flight checks (clean tree, on main, up to date)
#   2. Runs tests locally
#   3. Bumps version via npm version (which syncs openclaw.plugin.json)
#   4. Pushes commit + tag to origin
#
# PHI-VENDOR: upstream ended here by pointing at a CI job
# (.github/workflows/publish.yml) that published @askjo/camofox-browser with
# provenance. That workflow belongs to jo-inc/camofox-browser and does not exist
# in this monorepo, so nothing publishes on push: run `npm publish` from this
# directory yourself. The branch check also said `master`, which this repo does
# not have — the script stopped before doing anything either way.

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: ./release.sh [patch|minor|major]"
  exit 1
fi

cd "$(dirname "$0")"

# --- Pre-flight checks ---
echo "🔍 Pre-flight checks..."

# Clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# On main
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "❌ Not on main (on $BRANCH). Switch to main first."
  exit 1
fi

# Up to date with remote
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "❌ Local main ($LOCAL) differs from origin ($REMOTE). Pull/push first."
  exit 1
fi

# --- Tests ---
echo ""
echo "🧪 Running tests..."
JEST_OUTPUT=$(NODE_OPTIONS='--experimental-vm-modules' npx jest --runInBand --forceExit --testPathPattern='tests/unit' 2>&1)
echo "$JEST_OUTPUT" | tail -5
if echo "$JEST_OUTPUT" | grep -q 'Tests:.*failed'; then
  echo "❌ Tests failed"
  exit 1
fi
echo ""

# --- Version bump ---
CURRENT=$(node -p "require('./package.json').version")
echo "📦 Current version: $CURRENT"
echo "📦 Bumping: $BUMP"
echo ""

# npm version bumps package.json, runs the "version" lifecycle script
# (which syncs openclaw.plugin.json), creates a git commit and tag
npm version "$BUMP" --message "v%s"

NEW_VERSION=$(node -p "require('./package.json').version")
echo ""
echo "📦 New version: $NEW_VERSION"

# --- Push ---
echo ""
echo "📤 Pushing commit and tag..."
git push origin main --follow-tags

echo ""
echo "✅ v${NEW_VERSION} committed, tagged and pushed"
echo "   Nothing publishes on push in this repo — run: npm publish"
echo "   Package: https://www.npmjs.com/package/@phi-code-admin/camofox-browser"
