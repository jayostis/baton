# Baton

An issue spec to a reviewed PR, by deliberate handoff, and the way an epic of such issues is run cheaply. `deliver` never
merges. `epic` merges only through the project's own gate script, after the maintainer has said so in chat.

Each stage is blind to the one before it, and that is the whole design:

- the **tests** agent has not seen the intended implementation, so the tests cannot be shaped to fit it
- the **implement** agent did not write the tests, so it cannot quietly redefine *done*
- the **followup** agent did not write the code under review, so it cannot half-apply its own findings
- the **checklist** agent ticks nothing — every box is the maintainer's

A baton is the object that exists only to be handed over. Both of `deliver`'s exits are passes, never finishes:
`delivered <PR-URL>` hands over an unticked checklist, `blocked #N` hands over the issue with a label and an @mention.

## The skills

| skill | verbs | reach |
|---|---|---|
| `/baton:issue` | `review` · `create` · `groom` | reads, files, edits an issue |
| `/baton:pr` | `status` · `comments` · `review` · `followup` · `loop` · `ci` | reads, posts, pushes |
| `/baton:deliver` | *(none — takes an issue number)* | one issue through the pipeline, stopping before merge |
| `/baton:epic` | `<folder>` · `resume <folder>` · `retro <folder>` | orchestrates an epic: plan, critical read, waves, ledger, gate, handoff, retro |
| `/baton:tdd` | *(none)* | red-green-refactor; two agents depend on it |

No verb is a default: a bare `/baton:pr <n>` or `/baton:issue <n>` runs its read-only verb and says the verb was missing.

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

Development: `claude --plugin-dir ./baton`, then `/reload-plugins` after each edit. Tests: `node --test test/*.test.mjs`
(the directory form fails on Node 24). `claude plugin validate .` checks the manifest and `hooks/hooks.json`.

## Configuration

All keys are optional; the defaults work in a normal GitHub repo.

| key | default | what it does |
|---|---|---|
| `maintainer_handle` | — | Fallback @mention when a delivery blocks. Normally never reached (see below). |
| `escalation_label` | `needs-human` | Applied to the issue on a block. **Must already exist in the repo.** |
| `verify_command` | — | Pre-commit gate, run before pushing review fixes. Blank → agents report the targeted test run alone and say no gate ran. |
| `review_passes` | `2` | Review passes in `/baton:pr loop`: review, apply, review. `--passes n` overrides per run. |
| `project_config` | — | A file naming a project's epic tools and rules; see below. Blank → `.baton/project.md` in the repo. |

**Who gets the @mention** — first hit wins: an `Escalate to: @handle` line in the issue's Delivery block, every non-bot
assignee, the issue's author, `maintainer_handle`. A chain that yields nobody still blocks and says so.

## Project config

Baton carries no project's paths, rules or rulings. `/baton:epic` reads one markdown file, once: the `project_config` key
above, else `.baton/project.md` in the repository it runs in, and stops to ask if neither exists. Keep it under 120
lines. The briefs refer to its entries by these names; each is a command, a path or a short paragraph:

| entry | what it is |
|---|---|
| `gate` | the only merge path: reads state itself (mergeability, checks on the head, threads, a review for this head) |
| `wait_ci` | one blocking command that exits 0 only when every check on the head SHA passed |
| `worktree`, `review_worktree` | tools that give a builder a worktree per step and a reviewer a standing one |
| `verify_command`, `test_targeted` | the pre-push gate, and how to run only the tests a change affects |
| `depends_on` | how PRs in different repos name each other, and the order they merge |
| `stop_line` | the only conditions on which the orchestrator stops to ask |
| `rulings` | settled decisions, each with its reason |
| `traps` | a folder of dated entries, each with the test that proves it, loaded by grep on a topic, never pasted |
| `probes` | per-repository probe lists for reviewers |
| `locks` | the lock primitive for Docker and timed runs |

A project's own file lives in that project, never here.

## Running an epic

`/baton:epic` is an orchestrator that dispatches agents by a role table and spends tokens it can measure.

- **Role table**, `references/roles.json`: role, model, effort, token target, brief. Every dispatch names its model; the
  `Agent` hook refuses one that does not. Defaults: critical read Opus; builder Sonnet; review of new logic Opus, of a
  small diff Sonnet; fix always a fresh Sonnet at medium effort with at most ten findings; mechanical steps Haiku.
- **Ledger**, `scripts/ledger.mjs`: reads the session transcripts, so it costs no tokens and needs no token. Per agent: turns,
  peak context, cache read and write, output, minutes, and **cost units**. Slices with `--since`, `--until`, `--wave`;
  totals per wave against a budget in `waves.json`; `--agent <id>` prints the line for a handback; `--self` reads the
  orchestrator's own context; `--strict` exits 1 on an agent past the ceiling or a wave over budget.
- **Cost units** weight each token kind and each model; the weights are in `roles.json` and are list-price ratios, not
  measurements. The calibration from units to a percent of the week is **unset** until the first retro sets it from the
  maintainer's usage meter; until then status lines show units.
- **Hooks**, `hooks/hooks.json`: `SendMessage` is refused to an agent that has handed back (a fresh agent is cheaper than
  resuming one; a message starting `RESUME-APPROVED:` passes); a message to a running agent always passes. In an
  epic only (`scripts/epic-mode.mjs on`, or `BATON_EPIC=1`), a general-purpose `Agent` call without a model is refused;
  agent types with their own definition, forks and baton's agents are never. `SubagentStop` appends the agent's ledger
  row to the run log. `BATON_CONTEXT_CEILING` and `BATON_REQUIRE_MODEL=0` adjust them.
- **Lessons**, `references/lessons.md`: one-line rules tagged by role, capped at 80 lines by a test.
- **Retro**, `skills/epic/retro.md`: runs the ledger, compares with the project's `epics.csv`, reads the handback blocks and
  opens one PR to this repository. The maintainer merges it; nothing updates itself. `scripts/history.mjs` builds
  `epics.csv` rows from a spec of epics (attributing each session to the epic its transcript names most), which is also
  how epics that ran before the ledger can be backfilled approximately.

## What a project has to bring

- **The issue template.** [`references/agent-ready.yml`](references/agent-ready.yml) is the canonical copy and the thing
  `/baton:issue review` checks against; [`references/epic-step.yml`](references/epic-step.yml) is the lighter one for epic
  steps. A project needs its own copy under `.github/ISSUE_TEMPLATE/` for GitHub to render the form. Don't let them drift.
- **One label.** `needs-rework`, the maintainer's explicit stop. `/baton:deliver` blocks on it.
- **`gh`, authenticated, and a checkout of the repo that owns the PR.** `scripts/pr-review.mjs` checks both before it
  spawns anything. Everything in baton passes the repository explicitly or reads it from the checkout.
- **A Delivery block** on each issue naming the integration branch and the work branch. `deliver` never infers either.
- **For epics, the project config** above.

## Notes

`tdd` is here because two agents depend on it: the tests and implement agents both link to its outer/inner loop split.
