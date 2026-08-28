# `/baton:pr review <pr>` — hand the diff to the reviewer

Posts a review to the PR. Changes no files, touches no branch.

**A subprocess, not a subagent.** A reviewer holding the author's reasoning re-reads it
approvingly; a subprocess cannot inherit this session's.

## 1 — Pick the effort

- **First pass on a PR → `medium`.**
- **A later pass whose diff moved only in answer to the last one → `low`.**
- **A diff that moved on its own — a rebase, a redesign, commits no pass has seen → `medium`.**

`low` and `medium` report only the findings the reviewer is most confident in; `high` and above
broaden coverage and include findings it is less sure about. **A narrower level can also read
less** — a `low` pass has been seen declining test and fixture hunks and saying so in its scope
note.

**Which case you are in comes from the findings, never the threads.** [`followup`](followup.md)
resolves what it fixes, so thread state is emptiest exactly when a later pass is cheapest.

```bash
gh api repos/:owner/:repo/pulls/<pr>/comments \
  --jq '[.[] | select(.in_reply_to_id == null)] | max_by(.created_at) | .original_commit_id'
git log <that SHA>..HEAD --oneline
```

Nothing returned → **first pass**. Otherwise `git log` is exactly the code no pass has seen: fixes
answering the last pass → `low`; anything else → `medium`.

## 2 — Run it

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/pr-review.mjs --pr <pr> --level <level> --dir <checkout>
```

**`--dir` must be a checkout of the repo that owns the PR.** The reviewer resolves a bare PR
number against its working directory, so the directory is the target. `--repo owner/name` asserts
which one it had better be.

The script owns everything with one right answer: preflight, argument order, the tool grants, the
denial ledger, thread reconciliation, finding recovery, and classification. **Read the script if
you need to know how. Do not restate it here** — this file described that procedure in prose once
and it took six issues to stop.

## 3 — Act on the exit code

| exit | | do |
|---|---|---|
| **0** `clean` | ran, nothing denied, no findings | report a pass |
| **1** `findings` | posted as threads | [`followup`](followup.md), or [`loop`](loop.md) |
| **2** `preflight` | never started | **block** — the reason names what is missing |
| **3** `denied` | tool calls were denied | **block** — recovered findings are in the output, and are a floor rather than a count |
| **4** `unproven` | what it produced and what the PR holds disagree | **block** |
| **5** `inspected` | `--dry-run` or `--no-post` | nothing was posted; nothing is proven |

**Report findings from the threads**, via [`comments`](comments.md) — never from the script's
output and never from the reviewer's prose. The script proves a review happened; the PR is the
record of what it found.

**Two things the script cannot settle**, and a report should not pretend otherwise:

- The reviewer names its effort level only when it **reuses** one, so a wrong level is catchable
  and a right one is not confirmable.
- A narrow level may read part of the diff. Its scope note is the only signal, and it is prose.
