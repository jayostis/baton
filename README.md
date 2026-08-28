# Baton

An issue spec to a reviewed PR, by deliberate handoff. **Never merges.**

Each stage is blind to the one before it, and that is the whole design:

- the **tests** agent has not seen the intended implementation, so the tests cannot be shaped to fit it
- the **implement** agent did not write the tests, so it cannot quietly redefine *done*
- the **followup** agent did not write the code under review, so it cannot half-apply its own findings
- the **checklist** agent ticks nothing — every box is the maintainer's

A baton is the object that exists only to be handed over. Both of `deliver`'s exits are passes,
never finishes: `delivered <PR-URL>` hands over an unticked checklist, `blocked #N` hands over the
issue with a label and an @mention.

## The skills

| skill | verbs | reach |
|---|---|---|
| `/baton:issue` | `review` · `create` · `groom` | reads, files, edits an issue |
| `/baton:pr` | `status` · `comments` · `review` · `followup` · `loop` · `ci` | reads, posts, pushes |
| `/baton:deliver` | *(none — takes an issue number)* | the whole pipeline, stopping before merge |
| `/baton:tdd` | *(none)* | red-green-refactor; two agents depend on it |

No verb is a default. A bare `/baton:pr <n>` reports `status` and then says the verb was missing —
the shorter thing to type must not be the one that acts.

## Install

Personal, every project, no marketplace:

```bash
git clone git@github.com:jayostis/baton.git ~/.claude/skills/baton
```

It loads on the next session as `baton@skills-dir`. Or, from the marketplace:

```bash
/plugin marketplace add jayostis/baton
/plugin install baton@baton
```

Development: `claude --plugin-dir ./baton`, then `/reload-plugins` after each edit.

## Configuration

All four keys are optional; the defaults work in a normal GitHub repo.

| key | default | what it does |
|---|---|---|
| `maintainer_handle` | — | Fallback @mention when a delivery blocks. Normally never reached (see below). |
| `escalation_label` | `needs-human` | Applied to the issue on a block. **Must already exist in the repo.** |
| `verify_command` | — | Pre-commit gate, run with work staged before pushing review fixes. Blank → agents report the targeted test run alone and say no gate ran. |
| `review_command` | — | Project wrapper for the PR reviewer. Blank → the bundled `/code-review`. |
| `review_passes` | `2` | Review passes in `/baton:pr loop` — review, apply, review. `--passes n` overrides per run. |

**Who gets the @mention** — first hit wins, so `maintainer_handle` is a backstop rather than a setting
you need:

1. an `Escalate to: @handle` line in the issue's Delivery block
2. every non-bot assignee
3. the issue's author — always present, so the chain normally ends here
4. `maintainer_handle`

A chain that yields nobody still blocks, and says in the comment that no owner was identified.

## What a project has to bring

- **The issue template.** [`references/agent-ready.yml`](references/agent-ready.yml) is the canonical
  copy and the thing `/baton:issue review` checks against. For GitHub to render the form, a project
  needs its own at `.github/ISSUE_TEMPLATE/agent-ready.yml`. Don't let the two drift.
- **One label.** `needs-rework` — the maintainer's explicit stop. `/baton:deliver` blocks on it.
  No positive label is required: an issue is deliverable unless something says otherwise.
- **A Delivery block** on each issue naming the integration branch and the work branch. `deliver`
  never infers either — a derived name changes when the title is reworded, and the re-run then forks
  a second branch off the base.

## Notes

**`tdd` is here because two agents depend on it** — the tests and implement agents both link to its
outer/inner loop split. It is generic, 56 lines, and shipping it beats shipping a broken link.

**Agent names may be scoped** as `baton:deliver-tests-agent` depending on the session. `deliver`
says so at the point it spawns them.
