# `/baton:pr loop <pr>` [`--passes <n>`] — review, apply, repeat

Runs [`review`](review.md) and the followup agent against each other until the PR stops producing
findings. **The widest verb here**: it posts reviews, edits files and pushes, repeatedly.

**It always ends on a review**, so a run never finishes on an apply nobody read.

## How many passes

A pass is a **review**. The default is **2** — review, apply, review — which is one fix round with
a look at the result.

First hit wins:

1. `--passes <n>` on the invocation
2. `${user_config.review_passes}`
3. **2**

**More rounds is not more thorough.** Later rounds find few new true positives and generate
speculative ones, because the easy findings are gone and the reviewer is still being asked for
findings. Raising this buys noise the author then has to disprove. A last pass's findings are the
maintainer's, not another round's input.

## The loop

- **a. Review** — [`/baton:pr review <pr>`](review.md).
- **b. Decide** — `review` reported a pass, or that was the last allowed pass → **stop**.
  `review` **blocked** — it never ran, ran at the wrong level, could not post, or did not read
  what changed → **stop**, carrying its reason verbatim. A blocked review has cleared nothing.
- **c. Apply** — spawn
  [`pr-review-followup-agent`](../../agents/quality/pr-review-followup-agent.md) with the PR number
  **and nothing else**. Anything unfixed → **stop**. Pushed nothing → **stop**: the head has not
  moved, so the next review would read the same code and find the same things. Otherwise
  **back to a**.

## Exit

**One line, last, whatever else you printed.** A caller branches on it:

- `clean <pr> after <n> passes` — a review read what changed and found nothing.
- `stalled <pr> after <n> passes` — an apply pushed nothing; the head did not move.
- `exhausted <pr> after <n> passes` — the cap was reached with findings still open.
- `unfixed <pr> — <what the apply agent could not settle, verbatim>`
- `blocked <pr> — <why the review could not be trusted, verbatim>`

**`clean` asserts coverage, not just silence.** Where the last review's scope did not reach every
file changed since the pass before it, the exit names the gap rather than claiming a clean PR.

**`unfixed` and `blocked` are the failures**, and even then this verb neither labels nor escalates
— `pr` verbs touch the PR and never the issue. Whoever called it decides what that means.

## Report

Before the exit line: each pass, the level it actually ran at, what it found, and what the apply
settled or left open. Then [`status`](status.md), so the last word is the PR's state rather than
your account of it.
