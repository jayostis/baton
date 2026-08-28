---
name: issue
description: Work on an issue's specification before anyone builds from it — start one from the template, check it conforms, or groom it into shape with the maintainer. Use when writing a new issue, when one needs checking before dispatch, or when the maintainer wants a spec argued with.
argument-hint: "create|review|groom [<issue#>]"
---

# /baton:issue &lt;verb&gt; [&lt;issue#&gt;]

A **verb**, and an issue number for every verb but `create`.

**This skill writes no code.** `groom` reads it; nothing here branches, tests or opens a PR — that
is [`deliver`](../deliver/SKILL.md), which starts from what this leaves behind.

| verb | what it does | how far it reaches |
|---|---|---|
| [`review`](review.md) | does the issue conform to the template? structural, from its text alone | reads only |
| [`create`](create.md) | drafts a new issue from the template, with the maintainer | files an issue |
| [`groom`](groom.md) | reads the spec against the code and argues it into shape with the maintainer | edits the issue |

**The split is what an agent can decide alone.** `review` answers a mechanical question and can
run unattended — `deliver` calls it before anything else. `create` and `groom` need the maintainer in
the room, and neither runs without them asking.

**Read the file for the verb you were given and only that one.**

**No default.** Given a bare `/baton:issue <n>`, do [`review`](review.md), then say the verb was
missing. `review` only reads; the shorter thing to type must not be the one that acts.

## No verb approves a spec

**A grooming pass an agent both performs and accepts is not a gate.** `review` cannot approve
anything: conforming to a template says nothing about being right. `create` and `groom` could, and
must not — judging a spec sound is the maintainer's, having written or argued it rather than
merely read it.
