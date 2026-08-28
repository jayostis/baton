# `/baton:pr followup <pr>` — hand it to the agent

This edits files on the branch and pushes — one apply, once. [`loop`](loop.md) is this verb
repeated against `review` until the PR settles; reach for that when you want the cycle rather
than the single pass.

## 1 — Show what is outstanding

Do [`comments`](comments.md) first, so the handover is against a list you have both seen.
**Nothing unresolved → say so and stop.** There is no work to hand over.

## 2 — Hand it over

Spawn [`pr-review-followup-agent`](../../agents/quality/pr-review-followup-agent.md) with the PR
number and **nothing else**.

**Do not restate its workflow in the prompt.** It re-derives the thread list itself, and being
handed only a number is what keeps it independent of whoever is calling. A second copy of its
steps here would drift from
[the file that owns them](../../agents/quality/pr-review-followup-agent.md).

**Never the agent that wrote the code under review** — an author half-applying their own review
findings is the evidenced defect that agent exists to prevent.

## 3 — Report

Relay what came back: replies posted, threads resolved, threads left open **and why**. Anything
left open is what blocks.

Then **check the PR, not the report** — re-run [`comments`](comments.md) and confirm the replies
and resolutions actually landed. An agent can report success it did not achieve, and the threads
are the ledger, not its summary.
