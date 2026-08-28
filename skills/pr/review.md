# `/baton:pr review <pr>` — hand the diff to the reviewer

Posts a review to the PR. Changes no files, touches no branch.

**A subprocess, not a subagent.** A reviewer holding the author's reasoning re-reads it
approvingly; a subprocess cannot inherit this session's.

## 1 — Pick the effort

- **First pass on a PR → `medium`.**
- **A later pass whose diff moved only in answer to the last one → `low`.**
- **A diff that moved on its own — a rebase, a redesign, commits no pass has seen → `medium`.**

**Effort trades coverage for confidence.** At `low` and `medium` the review reports only the
findings it is most confident in; `high` and above broaden coverage and include findings it is less
sure about. So `high` is not "more thorough, therefore better" — it is a lower confidence bar, paid
for in findings the author has to disprove.

**Coverage is not only about how much is reported.** A narrower level can also read less: a `low`
pass has been observed declining whole file classes — test and fixture hunks — and saying so in its
own scope note. Whether that is deterministic is not established, which is why § 3 reconciles the
scope the reviewer reports against the files that changed rather than predicting it.

**A project can move this bar without touching this file.** The local reviewer follows the repo's
`CLAUDE.md`, so a convergence rule there — suppress nits after the first review, report Important
findings only — narrows later passes at the source rather than by choosing a lower level. It does
not read `REVIEW.md`, which is the managed service's file.

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

## 2 — Check it can run, then run it

**Two things this verb cannot do anything about, and must not discover halfway through.** Check
them first; either one failing is a **block**, not a review:

```bash
gh auth status                       # authenticated at all?
gh pr view <pr> --json headRefOid    # this PR reachable from this checkout?
```

**A project wrapper if one is configured, otherwise the bundled reviewer.**

```bash
${user_config.review_command} -- <pr> --comment --effort low|medium|high
```

Unset → `/code-review`, which ships with Claude Code and needs nothing installed:

```
/code-review <level> <pr> --comment
```

**The level comes first — before the flags, before the PR number.** Claude Code reads the effort
level, then the flags, and **everything left on the line is the review target**. So a level written
after the target is not a level at all: it is swallowed into the target, no error is raised, and
the pass runs at the remembered level instead. `--effort <level>` is not an argument it has either.

**Never omit the level.** Absent, `/code-review` **reuses the last level typed** — from an earlier
session, even — rather than defaulting to anything. § 1's `low` case then happens by accident, and a
first pass runs at a confidence bar nobody chose.

**A level passed in a `-p` run does not update the remembered one.** So the memory is not a record
of what has been run; never read it as one, and never let an omitted level stand in for a choice.

### Driving it headless

Where this is scripted rather than typed — `claude -p` — permission denials are the failure mode,
and they do not announce themselves in the exit code. **Declare the surface and read the ledger:**

```bash
claude -p "/code-review <level> <pr> --comment" \
  --output-format json \
  --permission-mode dontAsk \
  --allowedTools "Read" "Grep" "Glob" "Bash(gh pr view:*)" "Bash(gh pr diff:*)" "Bash(gh api:*)"
```

`dontAsk` turns a prompt that nobody can answer into an immediate denial rather than a silent
fall-through. The allowlist is a starting surface, not a guarantee — a project may need more.

**Which is why the ledger, not the list, is the check:**

```bash
jq '.permission_denials | length'
```

**Non-zero → block.** That catches the permissions nobody thought to allow, which is the whole
point: you do not have to enumerate correctly in advance, you have to refuse to report success when
something was denied.

`--comment` posts each finding as its own inline thread — anchored, unresolved — which is what
[`comments`](comments.md) lists and [`followup`](followup.md) acts on. **Pass it always**, and see
§ 3: posting can fail while the review itself succeeds.

## 3 — Reconcile, then report

**The threads are the ledger for findings.** Take the severity list and the review's URL from
[`comments`](comments.md), never from the subprocess's own account of itself. An agent can report a
review it did not post; deriving the report from the PR is what makes that impossible.

**But the reviewer states what it did, and that statement is evidence.** It names the level it ran
at, the scope it read, and whether posting worked. Read it as a **receipt** — never to harvest
findings, always to check the run against what you asked for:

| receipt says | check | mismatch means |
|---|---|---|
| the level it ran at | is it the level you asked for? | **block** — rerun, do not report |
| the scope it read | does it cover every file changed since the last pass? | **not a clean pass** — name the gap |
| findings it produced | is each one on the PR as a thread? | **block** — they exist and the PR does not hold them |
| `permission_denials` | empty? | **block** — something was denied |

**An empty ledger is three different things:**

| what happened | threads | report |
|---|---|---|
| ran, found nothing, read everything | 0 | **a pass** |
| ran, found things, could not post them | 0 | **block** — name them and where they are |
| never ran — refused, denied, PR unreachable | 0 | **block** — no code was reviewed |

**A non-empty ledger can be incomplete too.** Posting has been observed failing on some findings
and succeeding on others in one run, which leaves threads on the PR and findings that reached
nothing. Threads present is not threads complete; the count the reviewer reports is what you check
against.

**The exit code separates none of this.** The bundled reviewer runs inside `claude -p`, and a
session that explains why it cannot proceed has completed successfully by its own lights: exit `0`,
zero threads, no review object, `"is_error": false`. **Non-zero still blocks; zero proves nothing.**

**Do not go looking for a review object to confirm it.** A pass that finds nothing leaves none, so
absence is evidence of neither outcome.

**Where the receipt says nothing either way, say that.** A silent empty ledger is a pass you cannot
fully distinguish from a refusal that announced nothing. Name the limit rather than picking the
reading that suits you.

A pass that ran, read what changed, and found nothing is a result: report it as one, not as a
reason to run another. What they then need is [`followup`](followup.md) — or [`loop`](loop.md).
