#!/usr/bin/env bash
# scripts/ci-commit.sh — commit changed public/data/** back to the current branch
# with a fetch + rebase + push retry loop (4 attempts, exponential backoff) so
# concurrent/independent pushes never clobber each other.
#
# Usage: bash scripts/ci-commit.sh "<label>"
set -euo pipefail

LABEL="${1:-update}"
BRANCH="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"

git config user.name "capex-monitor-bot"
git config user.email "github-actions[bot]@users.noreply.github.com"

git add public/data
if git diff --cached --quiet; then
  echo "No data changes to commit."
  exit 0
fi

git commit -m "data: ${LABEL} update $(date -u +%Y-%m-%dT%H:%M:%SZ)"

delay=2
for attempt in 1 2 3 4; do
  echo "Push attempt ${attempt} (branch ${BRANCH})…"
  git fetch origin "${BRANCH}" || true
  if git rebase "origin/${BRANCH}"; then
    if git push origin "HEAD:${BRANCH}"; then
      echo "Pushed successfully."
      exit 0
    fi
  else
    echo "Rebase hit a conflict; aborting and retrying."
    git rebase --abort || true
  fi
  echo "Retry in ${delay}s…"
  sleep "${delay}"
  delay=$((delay * 2))
done

echo "ERROR: failed to push after 4 attempts." >&2
exit 1
