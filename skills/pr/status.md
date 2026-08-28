# `/baton:pr status <pr>` — everything still open on it

Four questions, four lines, **reads only**. Nothing here posts, edits or pushes.

## The four

**Threads** — unresolved count, from [`comments`](comments.md)'s query. `comments` is where you go
for the list; this is the count.

**Review** — has any pass left a finding, and did it see *this* head?

```bash
gh api repos/:owner/:repo/pulls/<pr>/comments \
  --jq '[.[] | select(.in_reply_to_id == null)] | max_by(.created_at) | .original_commit_id'
```

**Findings, not review objects** — `followup`'s replies each get an object too. **A pass that found
nothing left nothing**, so silence here means *no pass has complained*, never *no pass has run*.
Say it that way.

Every thread resolved is **not** the same as reviewed: `followup` resolves threads *and pushes
fixes*, so the tidiest apply leaves every thread closed and a head carrying code nobody read.

**CI** — the run for `gh pr view <pr> --json headRefOid`. Report its state and **infer no cause**.
Two results that are neither green nor a failure: every job `skipped`, and no run at all. Report
each as what it is; the project's triggers are not yours to guess.

**Checkboxes** — unticked items in the PR body's `## Verification` list. These are **the
maintainer's**, not work anything can do for them.

## Report

One line each, and **each names the verb that clears it**:

```
#42  fix/123-example → main   draft
Threads     2 unresolved · /baton:pr followup 42
Review      last pass saw 641bfe2, head is 0bda506 · /baton:pr review 42
CI          every job skipped · gh pr ready 42
Checkboxes  1 of 2 ticked · yours
```

**Never omit a line.** "Nothing." is the answer when there is nothing; a line that disappears when
it is clean is a line you cannot trust when it is absent.
