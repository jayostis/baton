---
name: pr
description: Work an open pull request — see everything still outstanding on it, review its diff, list unresolved threads, apply them, drive review and apply in a loop until it settles, or take one attempt at a red CI run. Use when a PR needs reviewing, when you want to know where it got to, when review comments need acting on, or when CI is red.
argument-hint: "status|review|comments|followup|loop|ci <pr>"
---

# /baton:pr &lt;verb&gt; &lt;pr&gt;

Two arguments, a **verb** and a **PR number**. They are told apart by shape — the number is the
numeric one — so either order works.

**Bind the PR number once.** Everything downstream writes `<pr>` and means that one number.
Never infer it from the branch, the issue or the last PR you saw.

## The verbs

| verb | what it does | how far it reaches |
|---|---|---|
| [`status`](status.md) | threads, review, CI and checkboxes — everything still open | reads only |
| [`comments`](comments.md) | list every unresolved thread and stop | reads only |
| [`review`](review.md) | adversarial pass over the PR diff, posted as inline threads | posts a review |
| [`followup`](followup.md) | hands the PR to `pr-review-followup-agent`, which replies, fixes and resolves | edits files, pushes |
| [`loop`](loop.md) | `review` and `followup` against each other until it settles, capped | posts, edits files, pushes |
| [`ci`](ci.md) | one look at the run; one fix attempt if it failed | edits files, pushes |

`status` is the one to reach for after a delivery: `/baton:deliver` leaves the PR open with a
checklist unworked and nothing watching it, and `status` is what says what is still waiting.

**Read the file for the verb you were given and only that one.** Each is self-contained, and
loading the others costs context for instructions you will not follow.

## No verb, no action

**There is no default.** Given a bare `/baton:pr <pr>`, do [`status`](status.md), then stop and say the
verb was missing, naming all six.

They differ by how far they reach — nothing, the PR, the branch — and typing a skill's name is not
consent to the widest of them. The shorter thing to type must not be the one that acts. Reporting
first is what keeps the refusal useful: you see what is outstanding, then choose.

**An unrecognised verb is not a near miss to be guessed.** Say what you were given, name the six,
and stop.
