#!/usr/bin/env bash
# Wait, without polling turns, until every workflow run on a PR's current head (or a commit) has finished,
# then print each run's conclusion and each failed or pending check. Run it with run_in_background.
#   wait-ci.sh <owner/repo> <pr-number>
#   wait-ci.sh <owner/repo> --commit <full-40-char-sha>
# Exit 0 when every check succeeded or was skipped, 1 otherwise.
set -u
repo=${1:-}; arg=${2:-}
if [[ "$repo" != */* || -z "$arg" ]]; then echo "usage: wait-ci.sh <owner/repo> <pr> | <owner/repo> --commit <sha>" >&2; exit 2; fi
if [ "$arg" = "--commit" ]; then sha=${3:?--commit needs a sha}; pr=""; else
  pr=$arg
  # A branch name or a stray sha in the PR's place found no PR and once still printed "all checks passed".
  [[ "$pr" =~ ^[0-9]+$ ]] || { echo "not a PR number: $pr (for a branch head use --commit <sha>)" >&2; exit 2; }
  # Right after a push GitHub can still report the previous head: read it until two reads 20 s apart agree.
  sha=$(gh pr view "$pr" -R "$repo" --json headRefOid -q .headRefOid)
  for _ in $(seq 1 6); do
    sleep 20
    again=$(gh pr view "$pr" -R "$repo" --json headRefOid -q .headRefOid)
    [ "$again" = "$sha" ] && break
    sha=$again
  done
fi
[ -n "$sha" ] || { echo "no head sha for ${pr:+pr #}${pr:-the commit} in $repo" >&2; exit 2; }
echo "repo $repo  head $sha  ${pr:+pr #$pr}"
# GitHub can take a few minutes to create a push's or a PR's runs.
n=0
for _ in $(seq 1 30); do
  n=$(gh run list -R "$repo" --commit "$sha" --json databaseId -q length 2>/dev/null || echo 0)
  [ "${n:-0}" -gt 0 ] && break
  sleep 20
done
[ "${n:-0}" -gt 0 ] || { echo "not passing: no workflow run for $sha after 10 minutes"; exit 1; }
until [ -z "$(gh run list -R "$repo" --commit "$sha" --json status -q '.[]|select(.status!="completed")|.status')" ]; do sleep 30; done
gh run list -R "$repo" --commit "$sha" --json name,conclusion,databaseId -q '.[]|"\(.conclusion)  \(.name)  run \(.databaseId)"'
if [ -n "$pr" ]; then
  # A DIRTY PR gets no checks at all, which would read as "all passed".
  ms=$(gh pr view "$pr" -R "$repo" --json mergeStateStatus -q .mergeStateStatus)
  [ "$ms" = "DIRTY" ] && { echo "not passing: PR is DIRTY against its base (merge main in)"; exit 1; }
  bad=$(gh pr checks "$pr" -R "$repo" --json name,state -q '.[]|select(.state!="SUCCESS" and .state!="SKIPPED")|"\(.state)  \(.name)"')
  [ -n "$bad" ] && { echo "not passing:"; echo "$bad"; exit 1; }
  echo "all checks passed or skipped"
else
  gh run list -R "$repo" --commit "$sha" --json conclusion -q '.[]|.conclusion' | grep -qvE '^(success|skipped)$' && exit 1
fi
exit 0
