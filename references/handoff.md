# HANDOFF.md template

Copy to `<epic>/HANDOFF.md`. At most 120 lines. A fresh orchestrator session reads only this, the project config
and `run.md`, so write what it cannot get from GitHub.

```
# <epic> handoff, <date and time>

## Authority
- Merge permission: granted by <maintainer> in chat on <date>, scope <what>. (Auto mode refuses without it.)
- Stop line: <from the project config>

## Waves
| wave | state | budget units | used | PRs and merge commits |
|---|---|---|---|---|

## In flight
| agent id | role | step | branch | last known state |
|---|---|---|---|---|

## Waiting on the maintainer
- <ruling or action, the issue it is on, my lean>

## Decided without the maintainer
- <decision, lean, reason>

## Machine
- Session dir for the ledger: <path>   Epic folder: <path>
- Locks held or stale: <names, owner pid, age>
- Unpushed work: <repo, branch, or none>   Tool paths: <from the project config, only what changed>

## Next
1. <the first thing the fresh session does>
```

Resume: read this, then `git ls-remote` and `gh pr list` for every repo in the table before believing it; start from
the first step whose output is missing. An agent listed in flight is lost; read its branch and dispatch a fresh one
with a note of what it left.
