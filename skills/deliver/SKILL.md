---
name: deliver
description: Take an issue to a reviewed PR, verified locally, taken out of draft and left with a checklist for the maintainer — verify the spec, failing tests first, implementation, review on the diff. Never asks in-session; escalates to GitHub with a label and an @mention. Never merges. Use when someone names an issue to work hands-off.
---

# /baton:deliver &lt;issue#&gt; [--worktree]

One issue in, one reviewed PR out, stopped short of merge. **Never asks a question in-session** —
every blocker goes to GitHub. **Never merges.**

**Agent names below are this plugin's own.** If your session lists them scoped —
`baton:deliver-tests-agent` — spawn the scoped form.

## Exit states

Report exactly one, as the final line:

- `delivered <PR-URL>` — ran to the end. **Not verified, not green, not free of open findings**;
  the `/baton:pr status` lines above it say what is true of the PR.
- `blocked #<issue> <reason>` — stopped short, label applied and comment posted.

## Blocking — escalate to GitHub

`gh issue comment N` **@mentioning the escalation target**, then `gh issue edit N --add-label
${user_config.escalation_label}` (default `needs-human`). The label does not notify; the mention
is what reaches a person.

**Target, first hit wins:** the Delivery block's `Escalate to:` → every non-bot assignee, all of
them → the issue's author → `${user_config.maintainer_handle}`.

```bash
gh issue view N --json assignees --jq '[.assignees[] | select(.is_bot | not) | .login]'
gh issue view N --json author --jq .author.login
```

**A chain yielding nobody still blocks** — comment, label, and say no owner was identified.
`--jq` returns an empty string rather than failing, so check explicitly: a bare `@` has notified
no one.

The comment is a hand-off to a stranger. Carry the branch, the head SHA, what was done, the
question, and **what each answer implies for the work**.

## Resuming

`/baton:deliver N` on an issue that already has work is **normal**. Read the issue's comments
first — a block posts the branch, the head SHA and what each answer implies.

**GitHub is the record; this machine is a cache.** Never conclude "no progress" from local state
until `git ls-remote` and `gh pr list` agree. Start from the first step whose output is genuinely
missing.

## Steps

**1 — Verify the issue.** `gh issue view N --json labels,title,body,assignees,author`.

`needs-rework` → **block.** No positive label is required; the conformance pass is the gate, not a
badge somebody remembered to apply. Then [`/baton:issue review <N>`](../issue/review.md) — **block
on what it blocks on**, quoting it.

**2 — Delivery block.** It names the **integration branch** (base and PR target) and the **work
branch**. **Never infer either** — a derived name changes when the title is reworded, so the
re-run misses the branch the last attempt pushed and forks a second off the base.

Block unless all three hold:

- both fields present and non-blank — `Merge into: #<issue>` is a reference, not a base
- **`Work branch` contains `N`** — catches a block pasted from another issue
- `git ls-remote --heads origin <integration branch>` finds it

The work branch need not exist yet. `Escalate to:` is optional and blocks on nothing.

**3 — Branch.**

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/branch.mjs \
  --work <work branch> --base <integration branch> [--worktree .claude/worktrees/<name>]
```

| exit | | do |
|---|---|---|
| **0** `ready` | on the branch, reconciled against origin | continue — the report names the cwd |
| **2** `preflight` | not a repo, fetch failed, base absent | **block** |
| **3** `dirty` | uncommitted changes a switch would drag onto the delivery | **block** |
| **4** `diverged` | local and origin both moved | **block** — two attempts ran; picking a side discards one |

`--worktree` gives the delivery its own checkout, which is what lets two run at once. `<name>` is
the work branch past its first `/`. **The script creates it; `EnterWorktree` with the path the
report names is how you get into it** — `EnterWorktree` alone cannot take a base, so it must never
be the thing that creates one. **Never `ExitWorktree`** — leave it for the maintainer.

**A skill or agent this branch adds is not live in this session** — discovery is a session-start
snapshot, and neither `EnterWorktree` nor `git switch` re-scans.

**4 — Tests.** Neither `unit` nor `e2e` ticked → **skip to Implement.** A declared `e2e` in a
worktree → **block** wherever the project serves E2E from one shared stack.

Otherwise spawn [`deliver-tests-agent`](../../agents/deliver/deliver-tests-agent.md) with the
issue's **Problem** and **Verification, verbatim and nothing else**. **Keep its report** — the
implementer builds to the stubs it invented.

**5 — Implement.** Spawn
[`deliver-implement-agent`](../../agents/deliver/deliver-implement-agent.md) with **Problem**,
**Scope**, **Verification**, and the tests agent's report. **Anything it reports as blocked →
block**, verbatim.

**Confirm it landed on origin** — `git status --porcelain` clean and the work in
`git log origin/<work branch>`. **A tool error proves nothing either way**: an agent can error
after writing every file, so the repo is the witness and the report is not.

**6 — Draft PR.** `gh pr list --head <work branch> --state open` first — `gh pr create` errors
when one exists, and on a resumed delivery it will. Found one → adopt it, and read its body,
reviews and commits; that thread is the handover. Otherwise `gh pr create --draft --base
<integration branch>` with `Closes #N` in the body. **Leave it a draft** — `gh pr ready` is
step 9's.

**7 — Review loop.** [`/baton:pr loop <pr>`](../pr/loop.md). Branch on its exit line and nothing
else: `unfixed` or `blocked` → **block**, verbatim. `clean`, `stalled` or `exhausted` → Checklist.

**8 — Checklist.** Spawn
[`deliver-checklist-agent`](../../agents/deliver/deliver-checklist-agent.md) with both numbers.
**Anything it reports as declared but absent → block** — this is the only step that compares what
the issue asked for against what the branch holds.

**9 — Ready, then report.** `gh pr ready`, then [`/baton:pr status <pr>`](../pr/status.md). **Its
four lines are your report — verbatim, whatever they say**, then the exit state. Running the verbs
it names is the maintainer's call. Never merge.
