# `/baton:pr loop <pr>` [`--passes <n>`] — review, apply, repeat

Runs [`review`](review.md) and the followup agent against each other until the PR stops producing
findings. **The widest verb here**: it posts reviews, edits files and pushes, repeatedly.

**At most three passes, and it always ends on a review.** `--passes` overrides the cap; a last
pass's findings are the maintainer's, not another round's input.

## The loop

- **a. Review** — [`/baton:pr review <pr>`](review.md).
- **b. Decide** — nothing found, or that was the last allowed pass → **stop**.
- **c. Apply** — spawn
  [`pr-review-followup-agent`](../../agents/quality/pr-review-followup-agent.md) with the PR number
  **and nothing else**. Anything unfixed → **stop**. Pushed nothing → **stop**: the head has not
  moved, so the next review would read the same code and find the same things. Otherwise
  **back to a**.

**A severity you saw on stdout and nowhere on the PR is not fixed** — the apply agent reads the
PR, not your stdout. Carry it to the exit as unfixed.

## Exit

**One line, last, whatever else you printed.** A caller branches on it:

- `clean <pr> after <n> passes` — a review found nothing.
- `stalled <pr> after <n> passes` — an apply pushed nothing; the head did not move.
- `exhausted <pr> after <n> passes` — the cap was reached with findings still open.
- `unfixed <pr> — <what the apply agent could not settle, verbatim>`

**Only `unfixed` is a failure**, and even then this verb neither labels nor escalates — `pr` verbs
touch the PR and never the issue. Whoever called it decides what that means.

## Report

Before the exit line: each pass, its effort, what it found, and what the apply settled or left
open. Then [`status`](status.md), so the last word is the PR's state rather than your account
of it.
