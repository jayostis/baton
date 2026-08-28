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
and they do not announce themselves in the exit code.

```bash
claude -p "/code-review <level> <pr> --comment" \
  --output-format json \
  --permission-mode dontAsk \
  --allowedTools Read Grep Glob Bash PowerShell \
  --disallowedTools Write Edit NotebookEdit
```

**The shell tools are granted whole, by bare name, and that is a real grant** — arbitrary shell on
the machine this runs on. Say it plainly rather than implying a curated list is achievable. Two
reasons a narrower one is not, both structural rather than tunable:

- **A prefix pattern matches a command string, and the reviewer composes shell.** `Bash(gh api:*)`
  does not match `SHA=$(gh pr view …) && gh api …`, so a command whose every constituent is allowed
  is still denied. Assignments, `$(…)`, `&&`, `;` and pipes all defeat it.
- **The tool depends on the platform.** On Windows the reviewer reaches for `PowerShell`, which no
  `Bash(…)` pattern can reach at all. A Bash-only surface denies most of what it does there.

**`--disallowedTools` is what carries the contract.** Deny rules are evaluated before the permission
mode and before any allow rule, so they hold. This verb changes no files and touches no branch;
those three entries are that sentence made enforceable. They are defence in depth, not a sandbox —
a deny pattern scoped inside `Bash(…)` is defeated by composition exactly as an allow pattern is,
which is why these are bare tool names.

`dontAsk` turns a prompt nobody can answer into an immediate denial rather than a silent
fall-through.

**The ledger is still the check:**

```bash
jq '.permission_denials | length'
```

**Non-zero → block.** With the shells granted it no longer fires on ordinary review work — reading
a sibling checkout, running a test to check a claim. It fires on the reviewer trying to write a
file, reach an MCP tool this session does not have, or use anything outside the granted set. That
is what it is for: not a mis-tuned list, but a review silently prevented from doing its job.

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

### Recovering a pass that could not post

**Blocking is right and it is not enough.** A review that could not post has still done the work,
and dropping it discards the whole pass. Salvage what exists, in this order, and say which it was:

- **A denied post carries its finding, verbatim.** In the JSON, `permission_denials[].tool_input`
  holds the command the reviewer was blocked from running — for a `gh api …/comments` call that is
  the complete body: file, line, side, argument. Fully recoverable.
- **Its limit, which must be stated when you use it:** only *attempted* posts are there, and a
  reviewer that is denied once tends to stop trying and switch to prose. A four-finding pass has
  been seen leaving **one** in the ledger.
- **`.result` is a summary, not a ledger.** It describes some findings and characterises the rest
  in a clause — *"two in the drift script's error reporting"* is not a finding and nobody can act
  on it. There is no findings array anywhere in the JSON; `.result` is the whole of it.

**Report every finding you recovered, in full, and name the ones you could not** — plainly, as
unrecoverable, with a re-run as the only remedy. A count is not a hand-off.

**This is the failure path only.** A pass that posted is still reported from the threads and
nothing else. Harvesting findings out of the receipt on a successful run reintroduces exactly what
this section forbids: an agent reporting a review the PR cannot corroborate.

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
