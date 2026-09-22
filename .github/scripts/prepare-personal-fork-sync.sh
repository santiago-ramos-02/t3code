#!/usr/bin/env bash
#
# Prepare the personal-fork sync candidate by merging the upstream ref into
# the current fork head, so fork-owned commits survive the sync.
#
# Usage: prepare-personal-fork-sync.sh [upstream-ref] [event-name]
#
# Writes build_sha, fork_sha, needs_push, should_build, and upstream_sha to
# $GITHUB_OUTPUT (or stdout when unset). Exits non-zero on merge conflicts
# after aborting the merge, so the workflow fails closed without publishing
# a candidate.

set -euo pipefail

upstream_ref="${1:-${UPSTREAM_REF:-upstream/main}}"
event_name="${2:-${GITHUB_EVENT_NAME:-schedule}}"

fork_sha="$(git rev-parse HEAD)"
upstream_sha="$(git rev-parse "$upstream_ref")"

should_build=false
needs_push=false
build_sha="$fork_sha"

if git merge-base --is-ancestor "$upstream_sha" HEAD; then
  if [[ "$event_name" == "push" || "$event_name" == "workflow_dispatch" ]]; then
    should_build=true
  fi
else
  if git -c user.name="personal-update-bot" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    merge --no-ff --no-edit -m "chore(fork): sync upstream code" "$upstream_sha"; then
    build_sha="$(git rev-parse HEAD)"
    needs_push=true
    should_build=true
  else
    if ! git merge --abort; then
      git reset --hard "$fork_sha"
    fi
    if [[ "$(git rev-parse HEAD)" != "$fork_sha" ]] ||
      ! git diff --quiet ||
      ! git diff --cached --quiet; then
      echo "error: merge of $upstream_ref failed and the original fork state could not be restored" >&2
      exit 1
    fi
    echo "error: merge of $upstream_ref into $fork_sha conflicts; aborted with no changes" >&2
    exit 1
  fi
fi

output="${GITHUB_OUTPUT:-/dev/stdout}"
{
  echo "build_sha=$build_sha"
  echo "fork_sha=$fork_sha"
  echo "needs_push=$needs_push"
  echo "should_build=$should_build"
  echo "upstream_sha=$upstream_sha"
} >> "$output"
