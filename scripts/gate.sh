#!/usr/bin/env bash
# The merge gate for one PR, checked rather than taken from a report:
# head, merge state, every check on the current head, unresolved review threads.
#   gate.sh <owner/repo> <pr> [--merge] [--allow <check name>]...
# Prints the verdict; with --merge, merges (merge commit) only when the gate passes. Never bypasses a BLOCKED,
# UNKNOWN or BEHIND PR. --allow names a check (by name prefix) that may be red; use it only for a check another repo's PR
# turns green, which the PR body names. Any check not named must succeed or be skipped.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib/events.sh"
repo=${1:-}; pr=${2:-}
if [[ "$repo" != */* || -z "$pr" ]]; then echo "usage: gate.sh <owner/repo> <pr> [--merge] [--allow <check name>]..." >&2; exit 2; fi
shift 2
merge=""; allowed=()
while [ $# -gt 0 ]; do
  case "$1" in
    --merge) merge=1 ;;
    --allow) allowed+=("${2:?--allow needs a check name}"); shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
owner=${repo%%/*}; name=${repo##*/}
# A merged or closed PR reports its merge state as UNKNOWN forever; say so instead of waiting it out.
prstate=$(gh pr view "$pr" -R "$repo" --json state -q .state) || exit 1
[ "$prstate" != "OPEN" ] && { echo "$repo#$pr is $prstate"; [ "$prstate" = "MERGED" ] && exit 0; exit 1; }
for _ in $(seq 1 12); do
  read -r head state base <<<"$(gh pr view "$pr" -R "$repo" --json headRefOid,mergeStateStatus,baseRefName -q '"\(.headRefOid) \(.mergeStateStatus) \(.baseRefName)"')"
  # GitHub computes mergeability lazily; UNKNOWN right after a push or a base change is not a verdict.
  [ "$state" != "UNKNOWN" ] && break
  sleep 10
done
bad=$(gh pr checks "$pr" -R "$repo" --json name,state -q '.[]|select(.state!="SUCCESS" and .state!="SKIPPED")|"\(.state)\t\(.name)"')
pending=$(printf '%s\n' "$bad" | awk -F'\t' '$1=="PENDING"||$1=="QUEUED"||$1=="IN_PROGRESS"' )
unallowed=$(printf '%s\n' "$bad" | while IFS=$'\t' read -r st nm; do
  [ -z "$nm" ] && continue
  ok=""; for a in "${allowed[@]:-}"; do [ -n "$a" ] && [[ "$nm" == $a* ]] && ok=1; done
  [ -z "$ok" ] && printf '%s %s\n' "$st" "$nm"
done)
threads=$(gh api graphql -f query="{repository(owner:\"$owner\",name:\"$name\"){pullRequest(number:$pr){reviewThreads(first:100){nodes{isResolved}}}}}" -q '[.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved|not)]|length')
echo "$repo#$pr -> $base  head $head  state $state  unresolved threads $threads"
[ -z "$(gh pr checks "$pr" -R "$repo" --json name -q '.[]|.name')" ] && echo "no checks on head"
[ -n "$bad" ] && { echo "checks not passing:"; printf '%s\n' "$bad"; }
[ ${#allowed[@]} -gt 0 ] && echo "allowed red: ${allowed[*]}"
okstate=""; [ "$state" = "CLEAN" ] && okstate=1
# With allowed red checks GitHub reports UNSTABLE; that is the expected state, never BLOCKED or BEHIND.
[ ${#allowed[@]} -gt 0 ] && [ "$state" = "UNSTABLE" ] && okstate=1
if [ -n "$okstate" ] && [ -z "$pending" ] && [ -z "$unallowed" ] && [ "$threads" = "0" ]; then
  echo "GATE PASSES"
  if [ -n "$merge" ]; then
    # A failed merge is not a merged one: gh's own message is on stderr, and the exit code says so.
    gh pr merge "$pr" -R "$repo" --merge || { echo "MERGE FAILED: gh pr merge exited non-zero for $repo#$pr" >&2; exit 1; }
    echo "merged"
    ev merge repo="$repo" pr="$pr" head="$head"
  fi
  exit 0
fi
echo "GATE DOES NOT PASS"
[ -n "$unallowed" ] && { echo "red and not allowed:"; printf '%s\n' "$unallowed"; }
exit 1
