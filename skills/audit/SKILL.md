---
name: audit
description: Drain the run log — read every baton run recorded across every project, and turn the recurring facts into file edits, drafted issues, or recorded no-actions. Drafts; never files. Use when asking what baton has been getting wrong, or on a regular sweep of the friction log.
argument-hint: "[--since <iso>]"
---

# /baton:audit

Three scripts append a record on every run, in every project baton is used in. **Nothing read them
until this verb existed.** That log is the only durable record of baton failing somewhere other
than here — a session sees one session; the log accumulates across repositories and weeks.

**The split is deterministic in the script, judgement in this file.** Reading JSONL, classifying by
rule, fingerprinting and deduping against issue bodies each have one right answer, so they are code
you run rather than steps you follow. What a candidate *means*, and what to do about it, is yours.

## Run the script

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit.mjs --repo <owner/name> --json
```

`--repo` names **this** repository — the one findings are filed against and deduped against, and
the only repository name the output is allowed to carry. It does **not** filter the read: the
friction happens in other projects and that is the entire point. Omit it only inside a checkout of
that repository, where `gh repo view` answers it.

`--since <iso>` narrows the window. `--runs <dir>` overrides where the log is read from; without
it, the log is wherever `BATON_HOME` says, which is the only correct answer.

**Exit codes are the contract:** `0` nothing to report — say so and stop. `1` candidates to
disposition. `2` preflight: it could not read the log, or could not read this repository's issues.
A run that cannot see what is already filed is a run that files it twice, so **`2` is a stop, not a
degraded pass.** Report the reason and stop.

## What comes back

```json
{ "candidates": [ { "fingerprint": "bf-…", "kind": "…", "title": "…",
                    "count": 3, "firstSeen": "…", "lastSeen": "…",
                    "tools": ["pr-review"], "projects": 1, "evidence": [ … ] } ],
  "skipped": 2, "scanned": 42, "dropped": { "dispositioned": 0, "alreadyFiled": 1 } }
```

- **`count` is records, not candidates.** Three identical preflight refusals are *one* candidate
  with a count of 3. A count is the evidence that something recurs; treat a count of 1 as weaker.
- **`fingerprint` is the dedupe key**, stable across runs. Anything you draft must carry it
  verbatim in the body, or the next run raises the same fact again.
- **`skipped` is a fact about the log**, not an error. Appends are concurrent, so a torn last line
  is expected. A *rising* skipped count across runs is itself worth a candidate.
- **The output is already redacted** — no absolute paths, no usernames, no repository name but this
  one, no review excerpts. This repository is public and the records carry other projects' work.
  **Do not go back to the raw log to enrich a draft.** Redaction is the reason this is safe to run.

## Every candidate gets exactly one of three fates

No candidate is left unaddressed. **A queue nobody dispositions is how a friction log dies**, and
that failure is the reason this is an auditor rather than another log.

| fate | when | what you do |
|---|---|---|
| **file edit** | the fact is already understood and the fix is documentation | edit `CLAUDE.md` or the skill that got it wrong, in this session |
| **drafted issue** | it needs work nobody has scoped | write the draft to a file and hand over the path |
| **no-action** | the fact is a guard working correctly, or a decision already made | append a disposition, with the reason |

### Drafting an issue

**Draft it in the shape of [`references/agent-ready.yml`](../../references/agent-ready.yml)** —
Problem, Scope, Verification types, Verification shapes — because that is the template
`/baton:issue review` checks against and `/baton:deliver` refuses without.

Put the fingerprint in the body on its own line so the next run finds it:

```
baton-fingerprint: bf-32bedaa09902edbc
```

**Write drafts to files and report the paths. Never create an issue.** Filing, labelling, closing
and commenting are all out of scope for this verb — the script contains no issue-creating call and
neither does this skill. The maintainer files what survives their reading.

### Recording a no-action

Append one line to `$BATON_HOME/dispositions.jsonl` (`~/.claude/baton/dispositions.jsonl` when
`BATON_HOME` is unset):

```json
{"fingerprint":"bf-…","ts":"2026-08-28T22:10:00.000Z","fate":"no-action","kind":"preflight-repeat","reason":"the pr-review --repo guard refusing a wrong-directory run; working as designed"}
```

The next run drops it before it ever reaches the issue query. **Give a reason worth reading in six
months** — a bare fingerprint records that somebody decided, not what they decided.

**A no-action is a judgement, not a way to clear the queue.** The repeated preflight refusal in the
real log is the honest case: the guard caught three wrong-directory runs and said so, three times.
That is the feature. A candidate you merely do not want to work on is a drafted issue.

## Report

Per candidate: its kind, its count, and which of the three fates it got with the reason. Then the
totals — `scanned`, `skipped`, and what was dropped as already filed or already dispositioned.

**Say when nothing came back.** Exit `0` over 42 records is a result: the log is clean and the
sweep happened. Silence reads as the verb not having run.
