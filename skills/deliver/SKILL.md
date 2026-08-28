---
name: deliver
description: Take an issue to a reviewed PR, verified locally, taken out of draft and left with a checklist for the maintainer — verify the spec, failing tests first, implementation, review on the diff. Never asks in-session; escalates to GitHub with a label and an @mention. Never merges. Use when someone names an issue to work hands-off, or when called from a workflow.
---

# /baton:deliver &lt;issue#&gt; [--worktree]

One issue in, one reviewed PR out, stopped short of merge. **Never asks a question
in-session** — every blocker goes to GitHub. **Never merges.**

**Agent names below are this plugin's own.** If your session lists them scoped —
`baton:deliver-tests-agent` rather than `deliver-tests-agent` — spawn the scoped form.

## Exit states

**Two ways out.** Report exactly one, as the final line, so a caller can branch on it:

- `delivered <PR-URL>` — ran to the end. **Not verified, not green, and not free of open findings** —
  the `/baton:pr status` lines above it say what is actually true of the PR.
- `blocked #<issue> <reason>` — stopped short, the escalation label applied and a comment posted.

## Blocking — escalate to GitHub

`gh issue comment N` **@mentioning the escalation target**, then
`gh issue edit N --add-label <escalation label>`. The label does not notify; the mention is what
reaches a person.

**Resolving the escalation target** — first hit wins:

1. The Delivery block's `Escalate to:` line, if the issue names one.
2. **Every assignee that is not a bot** —
   `gh issue view N --json assignees --jq '[.assignees[] | select(.is_bot | not) | .login]'`.
   Mention all of them. A block that reaches nobody is the failure this protocol exists to
   prevent, and an extra mention costs nothing.
3. **The issue's author** — `gh issue view N --json author --jq .author.login`. Always present on
   a GitHub issue, so in practice the chain ends here.
4. `${user_config.maintainer_handle}`, if the installer set one.

**A chain that yields nothing still blocks.** Post the comment, apply the label, and say in the
comment that no owner could be identified. What it must never do is render a bare `@` and carry
on — `--jq` returns an empty string rather than failing, so the check has to be explicit, and a
block nobody was notified of has not blocked anything.

The label is `${user_config.escalation_label}`, which defaults to `needs-human`.

The comment is a hand-off to a stranger — whoever resumes will not be you. Carry the branch, the
last commit SHA, what was done, the question, and **what each answer implies for the work**.

## Resuming

`/baton:deliver N` on an issue that already has work is **normal** — it is how an escalation
block picks up once the maintainer answers. Read the issue's comments first: a block posts the branch, the head
SHA and what each answer implies.

**GitHub is the record; this machine is a cache of it.** The last attempt may have run
elsewhere, so never conclude "no progress" from local state — absent local state means nothing
until `git ls-remote` and `gh pr list` agree. Start from the first step whose output is
genuinely missing; don't redo a committed red test just because it comes earlier in the list.

## Steps

**1 — Verify the issue.** `gh issue view N --json labels,title,body,assignees,author`.
The last two feed the escalation chain above; fetching them here costs no extra round trip.

- `needs-rework` → **block.** It is the maintainer's explicit stop, and every step below is built
  on a spec they have said is not ready.

**No positive label is required.** An issue is deliverable unless something says otherwise; the
conformance pass below is the gate, not a badge somebody remembered to apply.

Then [`/baton:issue review <N>`](../issue/review.md) — **block on what it blocks on**, quoting it.

**2 — Delivery block.** The issue's `Delivery` section names the **integration branch** — the base
to branch from and the PR target — and the **work branch** the commits go on.

**Never infer either one** — not from a milestone, a label, the issue title, or `main` as a
fallback. A derived name changes when the title is reworded, so the re-run misses the branch the
last attempt pushed and forks a second off the base.

Block unless all three hold, cheapest first:

- **both fields present and non-blank.** A `Merge into: #<issue>` is a parent *reference*, not a
  base; this skill does not walk issue graphs.
- **`Work branch` contains `N`** — what catches a block pasted from another issue, which
  otherwise lands the work on that issue's branch and pushes to a PR that isn't yours.
- **`git ls-remote --heads origin <integration branch>`** finds it.

The *work* branch need not exist yet.

`Escalate to: @handle` is **optional** and blocks on nothing. It only pre-empts the escalation
chain if a block happens.

**3 — Branch.** The work goes in **the checkout you are in**. `--worktree` puts it in its own
worktree instead — that is for running deliveries in parallel, since one checkout runs one.
Either way the branch is the Delivery block's `Work branch`, verbatim.

**Fetch before you look, look before you create** — a re-run is the normal way a block resumes,
and this machine may not be the one that ran the last attempt:

```bash
git fetch origin                              # everything below reads refs
git status --porcelain                        # dirty → block: a switch drags it onto the delivery
git ls-remote --heads origin <work branch>    # pushed from anywhere?
```

Default — `git switch`, then reconcile:

- branch is here → `git switch <work branch>`
- only on origin → `git switch --track origin/<work branch>`
- neither → `git switch -c <work branch> origin/<integration branch>`

With `--worktree`, `git worktree list` first, then:

- **Already inside one** — `git rev-parse --git-dir` ≠ `--git-common-dir`. A calling workflow
  may have provided it; `isolation: "worktree"` on the `agent()` call is how it does that, with
  no flag involved. Stay, but reconcile: being handed one says nothing about whether it is
  current.
- **One here for this branch** → `EnterWorktree` with `path`, then reconcile.
- **Branch on origin, no worktree here** — the second-machine case —
  `git worktree add --track -b <work branch> .claude/worktrees/<name> origin/<work branch>`. Not
  plain `-b`: that forks off the base and strips the delivery of everything already pushed.
- **Neither** →
  `git worktree add -b <work branch> .claude/worktrees/<name> origin/<integration branch>`.

`<name>` is the work branch past its first `/` — `fix/485-slug-charset` → `485-slug-charset`.
Deriving *that* is safe: it is a path, and nothing resumes by looking it up.

**Reconcile** with `git rev-list --left-right --count origin/<work branch>...HEAD` →
`behind ahead`. Behind → fast-forward. Ahead → unpushed work from a killed session; keep it.
**Both → diverged: block**, because two attempts ran and picking a side discards one. No branch
on origin — the `ls-remote` above missed, and this exits 128 rather than answering → all of it
is unpushed; keep it — the first agent to commit will push it.

`EnterWorktree` alone cannot take a base — it follows `worktree.baseRef`, which defaults to
origin's default branch, so it would silently ignore the integration branch. **Never
`ExitWorktree`** — leave the worktree for the maintainer.

**A skill or agent this branch adds is not live in this session** — discovery is a session-start
snapshot, and neither `EnterWorktree` nor `git switch` re-scans. Start the next session on the
branch, or land it.

**4 — Tests.** Neither `unit` nor `e2e` ticked → **nothing to write; skip to Implement.** A
declared `e2e` in a worktree → **block** wherever the project serves E2E from a single shared
stack: a worktree cannot serve its own code to it.

Otherwise spawn [`deliver-tests-agent`](../../agents/deliver/deliver-tests-agent.md) with the
issue's **Problem** and **Verification, verbatim and nothing else**. **Keep its report** — the
implementer builds to the stubs it invented.

**5 — Implement.** Spawn
[`deliver-implement-agent`](../../agents/deliver/deliver-implement-agent.md) with the issue's
**Problem**, **Scope** and **Verification**, and the tests agent's report if there was one.
**Anything it reports as blocked → block**, quoting it verbatim.

**Confirm it landed on origin** — `git status --porcelain` clean, and the work present in
`git log origin/<work branch>`. Everything after this reads origin, so a commit left in the
local tree is invisible to all of it. **A tool error proves nothing either way**: an agent can
error *after* writing every file, so the repo is the witness and the report is not.

**6 — Draft PR.** `gh pr list --head <work branch> --state open` first — `gh pr create` errors when
the branch already has one, and on a resumed delivery it will. Found one → adopt it, and read
its body, its reviews and its commits to see how far the last run got; that thread is the
handover. Otherwise `gh pr create --draft --base <integration branch>`, body includes
`Closes #N`.

**Leave it a draft.** `gh pr ready` belongs to the last step and happens nowhere else.

**7 — Review loop.** [`/baton:pr loop <pr>`](../pr/loop.md), which owns the cap and the break
conditions.

**Branch on its exit line**, and on nothing else:

- `unfixed` or `blocked` → **block**, quoting it verbatim.
- `clean`, `stalled` or `exhausted` → **go to Checklist**.

**8 — Checklist.** Spawn
[`deliver-checklist-agent`](../../agents/deliver/deliver-checklist-agent.md) with the issue and PR
numbers. It reads what the issue declared, finds each item in the branch, and writes the boxes
unticked — **they are all the maintainer's**, including the automated ones.

**Anything it reports as declared but absent → block**, quoting it. The issue asked for a
verification the branch does not contain, and this is the only step that compares the two.

**9 — Ready, then report.** `gh pr ready`, then [`/baton:pr status <pr>`](../pr/status.md). **Its four
lines are your report — verbatim, whatever they say**, then the exit state. It names a verb beside
each line; running one is the maintainer's call, not yours. Never merge.

## Called from a workflow

The contract a future caller must meet.

**Isolation is the caller's to give, not this skill's to ask for.** `isolation: "worktree"` on the
`agent()` call hands the agent a worktree, and the branch step's *already inside one* case finds
it — so a fanned-out workflow never passes `--worktree`. The flag is for running two deliveries
at once from one machine.
