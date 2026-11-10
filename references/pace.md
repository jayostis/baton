# Pace

Sharpen from the first step, and measure without becoming the slow part. Every mark is taken by a hook or script that
already runs; no agent spends a turn on measuring, and nobody profiles unless `--time` names a sink as big.

## What is marked, and where it is read

`<session-dir>/baton-events.jsonl`, one JSON object per line: `dispatch`, `launched` and `handback` (the hooks), `heavy-wait`,
`heavy-start` and `heavy-end` (`scripts/heavy.sh`: command, seconds waited for a slot, wall and cpu seconds, exit),
`ci-wait-start` and `ci-wait-end` (`scripts/wait-ci.sh`), `merge` (`scripts/gate.sh --merge`). `node ${CLAUDE_PLUGIN_ROOT}/scripts/mark.mjs <label> [k=v...]`
marks a key point no hook sees; use it rarely. Heavy events from an agent that has no session id in its environment go
to `baton-heavy-events.jsonl` in the temp directory, joined by time window and working directory. cpu is bash's `times`
where it counts a child's, else the machine's busy time over the run (`~`, an upper bound).

`ledger.mjs <session-dir> --time` is beside `--pace`, not in it: `--pace` is read at every handback and stays a few
lines; `--time` parses every transcript. Per step it shows wall clock to merge (`*`: no merge seen), agent, model and
tool minutes, heavy, CI and slot wait, cpu, units, peak context, rounds with reasons, and the orchestrator's latency
(each handback to the next dispatch or merge of its step; gaps over two hours are the maintainer away). Then a line per
wave and for the epic, as shares of the summed minutes, and the top three sinks. `--all` lists every step. Tool time is
split heavy, CI wait, git or gh, read or search, other from the transcripts alone, so it works with no events log.

## At Start

Read the config's `machine:` section (`node ${CLAUDE_PLUGIN_ROOT}/scripts/machine.mjs` prints the limits) and CI's runtime:
`gh run list -R <owner/repo> --limit 20 --json name,startedAt,updatedAt,conclusion`; the median run is how long every
push waits. Note both in `run.md`. A step that waits on CI longer than it builds wants a local gate on changed files.

## The pilot is a measurement

When the pilot's handback is in, run `--time`. Per phase (build, local gate, review, fix, CI) write what it cost; what
will repeat N times, with its cost each time; and the tool that would cut it. Build those in wave 0.

## Wave 0

Before wave 1 dispatches, build and try on the pilot what every step will run: the project's gate command (local on changed
files only, the full suite in CI), any page or report renderer, the mechanical checks a reader-facing review would
otherwise find, and the dispatch template (`scripts/dispatch.mjs` with the project's lines).

## The sharpening slot

One agent whose description key is `sharpen:` (role `sharpen`: heavy, Sonnet, `builder.md`) runs past the caps, and only one.
It takes no place from builders. At each wave boundary the top sink from `--time` gets one fix, by that agent or by you,
before the next wave dispatches; log it in `run.md` as "Sharpened".

## Round reasons

A fix description carries its reason after the step key: `fix: w3 s07b words`. The reasons are `words`, `test`, `review`,
`ci-red`, `flake`, `conflict` and `other`; the findings file opens with `Reason: <word>`, and `dispatch.mjs` copies it
into the description. `--pace` counts rounds by reason across steps and flags a reason seen twice (not `other`): that is a
tool or brief gap, built before the next agent of that role. The dispatch hook raises the same flags, and slot waits over ten minutes, as context on a dispatch; act on them first.
