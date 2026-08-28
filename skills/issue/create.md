# `/baton:issue create` — start one from the template

Takes no issue number. The point is to begin in the shape we want rather than write prose and
retrofit it.

## 1 — Read the template

[The template](../../references/agent-ready.yml) says what each field is for and what a good one
looks like. **It is the definition and is not restated here.** Read it before asking anything, so
the questions come from the fields rather than from a guess about what an issue needs.

The plugin ships the canonical copy. A project that wants GitHub to render the form needs its own
at `.github/ISSUE_TEMPLATE/agent-ready.yml`; where both exist they must not drift, because
[`review`](review.md) checks issues against the one it can read.

## 2 — Draft it with the maintainer

Ask about the fields, in whatever order the conversation takes. **A blank field beats a guessed
one** — the template's own rule, and the reason this is a conversation rather than a form filled
in on their behalf.

`Delivery` stays blank: it is filled when someone knows which branch this lands on.

## 3 — File it when they say so

```bash
gh issue create --title "<title>" --body-file <file>
```

`--template` only seeds body text and cannot render a YAML form, so **you are writing the body by
hand — reproduce the form's section headings exactly**, including `Verification types` as
`- [x]`/`- [ ]` checkboxes. `/baton:issue review` and `/baton:deliver` read those headings; a body that reads
well to a human and names its sections differently is unreadable to both.

Then [`review`](review.md) it. The conformance pass is free and catches a required field you both
talked past.

**Never apply a label** — see [`SKILL.md`](SKILL.md). Milestone and labels are the maintainer's.
