# `/baton:issue groom <issue#>` — work the spec into shape, with the maintainer

Interactive: a conversation with a pencil, not a pass with a verdict. **Run it when the maintainer asks and
never on your own initiative** — nothing dispatches it, and no agent invokes it. That is what
keeps it clear of the grooming pass [`SKILL.md`](SKILL.md) records as deleted.

**Every judgement in this file needs the maintainer in the room.** [`review`](review.md) can say an issue is
shaped right on its own; nothing here can say it is *right* on its own.

## 1 — Conform first

Run [`review`](review.md) and clear what it blocks on. Cheap, mechanical, and there is no point
arguing about the meaning of a field that isn't there.

## 2 — Read the code, then judge

Open the files the issue names and check its claims against them. **Which branch you read matters:**
the Delivery block's integration branch if it names one, otherwise ask the maintainer. Never whatever happens
to be checked out, and never `main` by assumption — the Delivery block is usually still blank at
grooming time, which is precisely when the answer is not obvious.

Then: **would the described verification fail today, and would passing it mean the Problem is
gone?** Where nothing automated can decide it, say so and make it `manual`.

## 3 — Hand it back

Summarise and stop: what `review` blocked on, where the code disagrees with the issue, what you
make of the verification, and what you could not judge.
