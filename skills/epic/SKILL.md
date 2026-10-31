---
name: epic
description: Run an epic as its orchestrator — plan, one critical read, waves of agents dispatched by a role table, a cost ledger at every handback, merge through the project's gate, status to the maintainer, handoff to a fresh session at your own context ceiling, then a retro that proposes changes to baton as one PR. Use when the maintainer names an epic, a folder of step issues, or says to run the plan.
argument-hint: "<epic folder> | resume <epic folder> | retro <epic folder>"
---

# /baton:epic

You orchestrate. You dispatch, read, gate, merge and log. You build nothing beyond a one-line edit. Every cost
decision below was learned in an epic that ignored it; read the ledger, not your impression of the spend.

## Start

1. **Project config.** Read once: `${user_config.project_config}`, else `.baton/project.md` in the repo you are in.
   Without one, ask for it and stop. It names the project's gate, CI wait, worktree tools, verify command, Depends-On
   pairing, standing rulings with reasons, the stop line and the probe files. Baton never carries a project's
   paths.
2. **Run folder** `<epic>/`: `HANDOFF.md` (template `${CLAUDE_PLUGIN_ROOT}/references/handoff.md`), `run.md`,
   `waves.json`, `steps/`, `notes/<step>.md`, `report.md`. A `resume` argument means read `HANDOFF.md` and
   continue from it; GitHub is the record, this machine a cache.
3. **Roles.** `${CLAUDE_PLUGIN_ROOT}/references/roles.json` is the table: role, model, effort, token target, brief.
   Briefs are in `${CLAUDE_PLUGIN_ROOT}/skills/epic/`. Read the table, do not restate it.
4. **Epic mode.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/epic-mode.mjs on` marks this session as an epic, which is what turns the
   model rule on; `off` when the retro is done. Without it no dispatch is refused.
5. **Lessons.** `${CLAUDE_PLUGIN_ROOT}/references/lessons.md`, tagged by role. Read the `[orchestrator]` and `[all]`
   lines now; each brief names the tag its agent reads.

## The loop

**Plan.** One issue per step, from `${CLAUDE_PLUGIN_ROOT}/references/epic-step.yml`: problem, in and out of scope,
the check that goes red first, files by name, settled sections cited. Fallout from a settled ruling is applied and
said in one line, never raised again.

**One critical read** before anything is built: the `critical-read` role, brief `critical-read.md`, over all the steps
together against the code. Apply its must-fixes to the issues. It also assigns each step a role and a wave. Steps that
want a design call get Opus; nothing else does.

**Waves.** Three to four agents at once; one at a time for anything that takes the Docker lock or times a run. Before
a wave starts, add it to `waves.json` (`{"w1": {"from": "<ISO now>", "budgetUnits": N}}`) and close it with `"to"` when
its last PR merges. `budgetUnits` and the role table's `unitTarget` are both cost units, so
the first budget is the sum of the wave's agents' targets, and later ones
come from the ledger.

**Dispatch.** Every general-purpose `Agent` call names `model` and `effort` from the role table, and starts its
`description` with the role key (`fix: w3 round 2`), which is how the ledger knows the role; the `PreToolUse` hook
refuses an unnamed model. The prompt has five lines for every role: 1 the subject (`<repo>#<n> <title>`, the PR, or the
command), 2 the absolute path of the role's brief, 3 the input file (step file, findings file, success exit code; blank
if none), 4 the absolute plugin root (`${CLAUDE_PLUGIN_ROOT}`, which the briefs' `references/` paths hang from), 5 the absolute
path of the project config. Then only what you hold that the issue does not (rulings, seam names, suites that cannot go
green yet), once, up front. Before dispatching a fix, name the code path that shows the behaviour; five minutes of
grep is cheaper than a round.

**Handback.** The agent ends with the block in `${CLAUDE_PLUGIN_ROOT}/references/handback.md`. Run
`node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs <session-dir> --agent <id>`, paste its line above the block in
`run.md`, and keep the block's one proposed change for the retro. A report is model output: check the repo.
Builders hand back once. Nothing is sent to an agent that has handed back; a fix round is a fresh agent. The
`SendMessage` hook enforces that; a message to a running agent always passes, so a stop reaches it. A `SubagentStop`
hook appends each agent's ledger row to the run log.

**CI.** One blocking command, run in the background by you (or by a `mechanical` agent when it is more than one
command), using the project's `wait_ci` tool. Nobody polls and no builder waits. Red goes to a fresh `fix` agent with
a log excerpt, never to the builder.

**Review.** Every PR gets an independent reader, `reviewer.md`, read-only, returning a ranked list. New logic gets
`review-new-logic`; a small or mechanical diff gets `review-small`; a byte-identical regeneration may be read by
you, logged. Related PRs may share one reviewer. A reviewer is told, in the prompt, the PR, the red log, the local runs
and the partner heads, so it does not rediscover them.

**Fix.** A fresh `fix` agent, brief `fix.md`, given the findings file and the branch, not the history. More than ten
findings: split into two agents. It posts one PR comment and pushes. Never `/baton:pr loop` in an epic.

**Merge.** Only through the project's `gate`, only after the maintainer has said in chat that you may, with the date
recorded in `HANDOFF.md`. The gate reads state itself (mergeability, checks on the current head, threads, a review for
this head); a report from an agent is never the gate. No `--admin`. Pairs merge back to back.

**Walk.** When the last PR is merged, the `walk` role, `walk.md`, drives what shipped. Its findings become issues;
count them for the retro.

## Decide, do not ask

You stop for the stop line in the project config and for nothing else. A choice you make is logged in `run.md`
under "Decided without the maintainer", with its lean and its reason. What needs the maintainer goes on the one
standing rulings issue, with your lean, batched. Do not wait on an answer you can proceed without.

## Cost

- Run `ledger.mjs <session-dir> --waves <epic>/waves.json --strict` at the end of each wave and whenever a
  status is due. It prints cost units per agent, per model and per wave against the budget, and warns on an agent past
  the context ceiling or past its role's token target.
- Status to the maintainer, at wave boundaries and whenever a budget is exceeded, not every message: what merged
  (issue titles with links), what is waiting on them, reviews and skips named, the decisions made without them, and a
  usage line from the ledger (units, or a percent of the week once `roles.json` has a calibration).
- Cost units are not tokens: weights per model and token kind are in `roles.json`, and each retro may recalibrate them.
  Each retro resets the calibration from a fresh reading of the maintainer's usage meter.

## Your own context

You are the most expensive agent in the run and you are re-read every turn. At each wave boundary run
`ledger.mjs --self`; when your own last context is past `ceilingTokens` in `roles.json`, stop dispatching, write
`HANDOFF.md` (wave state with merge commits, what is waiting on the maintainer, tool paths, stale locks, agents in
flight), push whatever is unpushed, and tell the maintainer to start a fresh session with `/baton:epic resume <epic>`.
Do not compact and carry on.

## Retro

When the walk is done, `retro.md`. It ends in one PR to baton that the maintainer merges; nothing here updates itself.

## Rules that outlive a brief

- A rule with a script check is the script. Call `scripts/`, never paraphrase a flag list.
- The repo is the witness: `git log origin/<branch>`, the PR's checks on its head SHA, the threads.
- Never `/baton:pr loop`; never resume a finished agent; never name a model by omission.
- A measurement that changes no decision is not taken.
