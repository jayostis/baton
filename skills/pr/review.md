# `/baton:pr review <pr>` — hand the diff to the reviewer

Posts a review to the PR. Changes no files, touches no branch.

**A subprocess, not a subagent.** A reviewer holding the author's reasoning re-reads it
approvingly; a subprocess cannot inherit this session's.

## 1 — Pick the effort

- **First pass on a PR → `medium`.**
- **A later pass whose diff moved only in answer to the last one → `low`.**
- **A diff that moved on its own — a rebase, a redesign, commits no pass has seen → `medium`.**

**Effort trades coverage for confidence.** At `low` and `medium` the review reports only the
findings it is most confident in; `high` and above broaden coverage and include findings it is
less sure about. So `high` is not "more thorough, therefore better" — it is a lower confidence bar,
paid for in findings the author has to disprove. `max` and `ultra` exist; this verb does not reach
for them, and asking for one is the caller's deliberate choice, not this table's.

**Which case you are in comes from the findings, never the threads.** [`followup`](followup.md)
resolves what it fixes, so thread state is emptiest exactly when a later pass is cheapest.

```bash
gh api repos/:owner/:repo/pulls/<pr>/comments \
  --jq '[.[] | select(.in_reply_to_id == null)] | max_by(.created_at) | .original_commit_id'
git log <that SHA>..HEAD --oneline
```

**Findings, not review objects** — `followup`'s replies are each wrapped in a review object of
their own, so counting those counts its answers as passes. `in_reply_to_id` tells a finding from an
answer to one. **A pass that finds nothing leaves no object at all.**

Nothing returned → **first pass**, which is also the right answer after a clean pass. Otherwise
`git log` is exactly the code no pass has seen: fixes answering the last pass → `low`; a rebase,
new work, anything else → `medium`.

## 2 — Run it

**A project wrapper if one is configured, otherwise the bundled reviewer.**

```bash
${user_config.review_command} -- <pr> --comment --effort low|medium|high
```

Unset → `/code-review`, which ships with Claude Code and needs nothing installed:

```
/code-review <pr> <level> --comment
```

**The level is a bare word, not a flag.** `/code-review` takes it positionally — `low`, `medium`,
`high`, `max`, `ultra`. **`--effort <level>` is not an argument it has**: it is ignored in silence,
and the pass then runs at whatever level was typed last. A wrapper builds its own argv and may
take flags; the bare-word form is the bundled one.

**Never omit the level.** Absent, `/code-review` **reuses the last-typed level** rather than
defaulting to anything — so an omitted level does not mean `medium`, it means whatever the previous
caller wanted, which is state you cannot see. § 1's `low` case then happens by accident, and a
first pass runs at a confidence bar nobody chose.

`--comment` posts each finding as its own inline thread — anchored, unresolved — which is what
[`comments`](comments.md) lists and [`followup`](followup.md) acts on. **Pass it always**, and see
§ 3: posting can fail while the review itself succeeds.

**Nothing goes after the PR number and the level.** Everything past them and the flags is read as
the review target, so an appended note becomes a nonsense target rather than context.

## 3 — Report

**The threads are the ledger for findings.** Take the severity list and the review's URL from
[`comments`](comments.md), never from the subprocess's stdout. An agent can report a review it did
not post; deriving the report from the PR is what makes that impossible.

**An empty ledger is three different things**, and telling them apart is this step's whole job:

| what happened | threads | report |
|---|---|---|
| ran, found nothing | 0 | **a pass** |
| ran, found things, could not post them | 0 | **block** — name them and where they are |
| never ran — refused, denied, PR unreachable | 0 | **block** — no code was reviewed |

**The exit code does not separate these.** The bundled reviewer runs inside `claude -p`, and a
session that explains why it cannot proceed has completed successfully by its own lights: exit
`0`, zero threads, no review object. **Non-zero still blocks; zero proves nothing.**

**So read stdout for the receipt, never for the findings.** That is the one thing it is good for.
A refusal names itself, and a failure to post names itself. [`loop`](loop.md) already depends on
this: a severity seen on stdout and nowhere on the PR is carried as unfixed.

- Findings on stdout, zero threads → **block.** They exist, and nothing on the PR holds them.
- A refusal, a permission denial or an unreachable PR on stdout → **block.** No code was reviewed.
- Neither, zero threads, exit `0` → **a pass.** Report it as one.

**Do not go looking for a review object to confirm it.** A pass that finds nothing leaves none, so
absence is evidence of neither outcome.

**Where stdout says nothing either way, say that.** A silent empty ledger is a pass you cannot
fully distinguish from a refusal that announced nothing. Name the limit rather than picking the
reading that suits you.

A pass that ran and found nothing is a result: report it as one, not as a reason to run another.
What they then need is [`followup`](followup.md) — or [`loop`](loop.md), which runs both until the
PR settles.
