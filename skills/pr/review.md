# `/baton:pr review <pr>` — hand the diff to the reviewer

Posts a review to the PR. Changes no files, touches no branch.

**A subprocess, not a subagent.** A reviewer holding the author's reasoning re-reads it
approvingly; a subprocess cannot inherit this session's.

## 1 — Pick the effort

- **First pass on a PR → `medium`.**
- **A later pass whose diff moved only in answer to the last one → `low`.**
- **A diff that moved on its own — a rebase, a redesign, commits no pass has seen → `medium`.**

**Effort trades coverage for confidence.** At `low` and `medium` the review reports only the
findings it is most confident in; `high` through `max` broaden coverage and include findings it is
less sure about. So `high` is not "more thorough, therefore better" — it is a lower confidence bar,
paid for in findings the author has to disprove.

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
${user_config.review_command} -- <pr> --effort low|medium|high --comment
```

Unset → `/code-review <pr> --effort low|medium|high --comment`, which ships with Claude Code and
needs nothing installed.

**Always pass the effort.** Both default to `medium` when it is absent, so forgetting to choose is
a silent medium pass rather than an error, and § 1's `low` case never happens by accident.

**What a wrapper is for.** It builds the argv in code rather than here, and turns a non-zero exit
into a stated refusal rather than silence. Where a project's permission rules deny the reviewer's
own invocation headless, the wrapper is what carries an allowed one.

`--comment` posts each finding as its own inline thread — anchored, unresolved — which is what
[`comments`](comments.md) lists and [`followup`](followup.md) acts on. **Pass it always.**

**Nothing goes after the PR number.** Everything past the effort level and the flags is read as the
review target, so an appended note becomes a nonsense target rather than context.

**Findings reach stdout on about half of runs.** The threads are the ledger; never parse the text
for them.

## 3 — Report

**Run [`comments`](comments.md) first and report out of it** — the threads are the source for the
severity list and the review's URL, never the subprocess's stdout. An agent can report a review it
did not post; deriving the report from the PR is what makes that impossible.

**Zero threads is not a clean pass on its own.** A denied permission rule, an auth failure, a rate
limit and a genuine no-findings run all print nothing and are indistinguishable here. **The exit
code is what tells them apart** — `0` means the subprocess ran to completion. Non-zero → **block**,
do not report a pass.

**Do not go looking for a review object to confirm it.** A pass that finds nothing leaves none, so
absence is evidence of neither outcome.

A pass that ran and found nothing is a result: report it as one, not as a reason to run another.
What they then need is [`followup`](followup.md) — or [`loop`](loop.md), which runs both until the
PR settles.
