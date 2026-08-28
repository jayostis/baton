# `/baton:issue review <issue#>` — does it conform to the template?

A **structural** check, answerable from the issue text alone. No code read, no judgement about
whether the spec is any *good* — that is [`groom`](groom.md), where a human is in the room.

So a clean pass means one narrow, true thing: **this issue is shaped right.** It is not a
statement that the issue is correct, achievable or worth doing, and nothing about it substitutes
for a person reading the spec.

[The template](../../references/agent-ready.yml) is the definition of a well-formed
issue and **is not restated here.** Read it, check the issue against it, and report the gaps.

## Blocking — a required field missing or unusable

Three the template marks `required`, so a filed issue already has them and a blank one is an edit
somebody made since:

- **Problem** — present and non-blank.
- **Scope** — present, and says what is **out**. A Scope with no out-boundary is the common real
  defect: nobody can tell an unattended agent to stop, so absence of a boundary is absence of a
  brake.
- **Verification shapes** — an entry for every type ticked, and a command for each `unit` / `e2e`.

And one only this check can enforce:

- **Verification types** — at least one ticked. `none` ticked alongside anything else is a
  contradiction, not a shorthand. **A GitHub form cannot mark a `checkboxes` field required**, so
  nothing upstream catches an untouched one — an issue declaring no verification at all reaches
  `/baton:deliver` looking complete.

## Notes — everything else the template states

Not blocking on their own; report them.

- **Acceptance criteria** — whether a long list is several separable changes wearing one number.
  The count itself is never the deviation: a holistic fix states its whole shape, and the cap that
  used to sit here is what fragmented one into pieces that each described a symptom.
- **Files and symbols** — no line numbers. Whether the symbols exist is `groom`'s question.
- **Open questions** — no unresolved `[NEEDS CLARIFICATION: …]`. A grep, not a judgement, and one
  present means the issue is not dispatchable.
- **Delivery** — presence only. `/baton:deliver` owns whether it is usable.

## Report

```
/baton:issue review #<n>

BLOCKS   — required field missing or unusable, one line each
NOTES    — everything else, one line each
CONFORMS — say so plainly when it does
```

**Report, do not fix** — not even an obvious wording repair. Reading only is what makes this safe
to run unattended from `/baton:deliver`. Editing is [`groom`](groom.md).

**Never apply a label and never post to the issue.**
