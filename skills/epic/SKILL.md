---
name: epic
description: Run an epic as its orchestrator — plan, one critical read, waves of agents dispatched by a role table, a cost ledger at every handback, merge through the gate, status to the maintainer, handoff to a fresh session at your own context ceiling, then a retro that proposes changes to baton as one PR. Use when the maintainer names an epic, a folder of step issues, or says to run the plan.
argument-hint: "<epic> | resume <epic> | retro <epic>"
---

# /baton:epic

You orchestrate. You dispatch, read, gate, merge and log. You build nothing beyond a one-line edit. Read the ledger, not
your impression of the spend.

## Start

1. **Project config.** Read once: `${user_config.project_config}`, else `.baton/project.md` in the repo you are in.
   Without one, ask for it and stop.
2. **Run folder** `<epic>/`: a name with no slash means `<run_folders>/<name>` from the config; a path is used as
   given. Without `run_folders`, ask. Working state only: `HANDOFF.md` (template
   `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`), `run.md`, `waves.json`, `steps/`, `notes/<step>.md`. `resume` reads
   `HANDOFF.md` and continues; GitHub is the record, this machine a cache.

   Anything lasting (design, research, results, decisions, reports) goes on GitHub the same turn. Delete the run folder when the epic closes; a paused epic keeps it.

3. **Roles.** `${CLAUDE_PLUGIN_ROOT}/references/roles.json` is the table: role, model, effort, token target, brief.
   Briefs are in `${CLAUDE_PLUGIN_ROOT}/skills/epic/`.
4. **Epic mode.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/epic-mode.mjs on` marks this session as an epic, which turns on the model,
   dispatch and machine hooks; `off` when the retro is done.
5. **Lessons.** `${CLAUDE_PLUGIN_ROOT}/references/lessons.md`, tagged by role. Read the `[orchestrator]` and `[all]`
   lines now; each brief names the tag its agent reads.
6. **Machine and CI.** Read the config's `machine:` section and CI's runtime (`references/pace.md`).

## The loop

**Plan.** One issue per step, from `${CLAUDE_PLUGIN_ROOT}/references/epic-step.yml`: problem, in and out of scope,
the check that goes red first, files by name, settled sections cited. Fallout from a settled ruling is applied and
said in one line, never raised again.

**One critical read** before anything is built: the `critical-read` role, brief `critical-read.md`, over all the steps
together against the code. Apply its must-fixes to the issues. It also assigns each step a role and a wave. Steps that
want a design call get Opus; nothing else does.

**Waves.** Agents at once are capped by weight, heavy (builders, fixers) and light (readers, reviewers), from the
project config's `machine` section else this machine; `node ${CLAUDE_PLUGIN_ROOT}/scripts/machine.mjs` prints the caps, and
the dispatch hook refuses past them: wait for a handback. Every local build or test runs through
`bash ${CLAUDE_PLUGIN_ROOT}/scripts/heavy.sh <command>`, which the Bash hook enforces, on the changed files only; the full
suite, random-order seeds and coverage run in CI, which is free compute beside this machine. One at a time for anything
that takes the Docker lock or times a run. Before a wave starts, add it to `waves.json`
(`{"w1": {"from": "<ISO now>", "budgetUnits": N}}`) and close it with `"to"` when its last PR merges. `budgetUnits` is cost
units: the sum of the wave's agents' role targets at first, then from the ledger.

**Sharpen first** (`references/pace.md`). The pilot also measures the loop: after its handback, a review of
`ledger.mjs <session-dir> --time` names what will repeat N times and its cost each time; the tools that cut it come
from that. Wave 0 builds what every step will run and tries it on the pilot before wave 1 dispatches. One agent whose
description key is `sharpen:` runs past the caps. At each wave boundary the top sink of `--time` gets one fix first.

**Dispatch.** Every general-purpose `Agent` call takes its prompt from
`node ${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs <role> "<step key>" "<subject>" [--input <file>] [--slot <n>]`, which prints the
`description` to pass (`fix: w3 s07b words`: the role key, the step key, a fix's reason; the ledger reads role and step
from it), the model and effort, the prompt's five lines and a reviewer's `review_worktree` call. Pass them as printed;
the `PreToolUse` hook refuses an unnamed model. Then add only what you hold that the issue does not (rulings, seam names,
suites that cannot go green yet), once, up front. Before dispatching a fix, name the code path that shows the behaviour.

**Handback.** The agent ends with the block in `${CLAUDE_PLUGIN_ROOT}/references/handback.md`. Run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs <session-dir> --agent <id>`, paste its line above the block in
`run.md`, and sharpen (below).
Nothing is sent to an agent that has handed back; a fix round is a fresh agent. The
`SendMessage` hook enforces that; a message to a running agent always passes.

**CI.** One blocking command, run in the background by you (or by a `mechanical` agent when it is more than one
command), using `bash ${CLAUDE_PLUGIN_ROOT}/scripts/wait-ci.sh <owner/repo> <pr>`. Nobody polls; no
builder waits. Red goes to a fresh `fix` agent with a log excerpt, never to the builder.

**Review.** Every PR gets an independent reader, `reviewer.md`, read-only, returning a ranked list. New logic gets
`review-new-logic`; a small or mechanical diff gets `review-small`; a byte-identical regeneration may be read by
you, logged. Related PRs may share one reviewer. Its prompt also names the red log, the local runs and the partner heads,
so it does not rediscover them.

**Fix.** A fresh `fix` agent, brief `fix.md`, given the findings file and the branch, not the history. The findings
file quotes the reviewer's items and any ruling they touch word for word, and names the targeted test command from the
project config. It opens with `Reason: <word>` (words, test, review, ci-red, flake, conflict, other), which `dispatch.mjs`
puts in the description. More than ten findings: split into two agents. It posts one PR comment and pushes. A CI red on
a branch whose fixer is still running goes to that fixer by `SendMessage`. Never `/baton:pr loop` in an epic.

**Merge.** Only through `bash ${CLAUDE_PLUGIN_ROOT}/scripts/gate.sh <owner/repo> <pr> [--merge] [--allow <check>]...`,
only after the maintainer has said in chat that you may, the date recorded in `HANDOFF.md`. The gate reads state
itself (mergeability, checks on the current head, threads), never a review: confirm the PR's head is the one reviewed
(or a fix round's push the review covered). `--allow` is only for a check a Depends-On partner's PR turns green, which
the PR body names. No `--admin`. Pairs merge back to back.
After each merge, start `wait-ci.sh` on the base branch's new head in the background; a red main is the next fix.

**Walk.** When the last PR is merged, the `walk` role, `walk.md`, drives what shipped. Its findings become issues;
count them for the retro.

## Sharpen as you go

At every handback read the block's proposed change and `ledger.mjs <session-dir> --pace` (rounds by reason and minutes
per step; it flags two rounds, a reason seen twice, and a builder past twice the builders' median). A change that would
save a round, an agent or a recurring wait is applied before the next dispatch, not kept for the retro: a tool built, a
brief or template fixed, a gate cut. Log it in `run.md` as "Sharpened". One reason twice is a tool or brief gap: build it
before the next agent of that role. Only a change to this skill's own design waits for the retro.
Hooks and scripts mark time by themselves; never time anything by hand, and profile only a sink `--time` calls big.

## Decide, do not ask

You stop for the stop line in the project config and for nothing else. A choice you make is logged in `run.md`
under "Decided without the maintainer", with its lean and its reason. What needs the maintainer goes on the one
standing rulings issue, with your lean, batched. Do not wait on an answer you can proceed without.

## Cost

- Run `ledger.mjs <session-dir> --waves <epic>/waves.json --strict` at each wave's end and when a
  status is due. It warns on an agent past the context ceiling or its target, and a wave past its budget.
- Status to the maintainer at wave boundaries and when a budget is exceeded: what merged (titles with links), what waits
  on them, reviews and skips, decisions made without them, a usage line from the ledger.

## Your own context

You are the most expensive agent in the run: every turn re-reads your whole context. At each wave boundary, and only
there, run `ledger.mjs --self --waves <epic>/waves.json`. It prints your last context and whether a fresh session would save at least `handoff.minimumUnitsSaved`. On yes: stop dispatching, write `HANDOFF.md`, push whatever is unpushed, and
tell the maintainer to start a fresh session with `/baton:epic resume <epic>`. On no, carry on. Either way, paste the
`handoff-decision` line it prints into `run.md`. Never judge your context from memory or a compaction summary.

## Retro

When the walk is done, `retro.md`: one PR to baton, which the maintainer merges.

## Rules that outlive a brief

- A rule with a script check is the script. Call `scripts/`, never paraphrase a flag list.
- The repo is the witness: `git log origin/<branch>`, the PR's checks on its head SHA, the threads.