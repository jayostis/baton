# CLAUDE.md

Baton drives two things it does not control — `/code-review` and `gh` — from a plugin that runs
on Windows and Linux. Everything below cost a bug to learn.

## The rule this repository exists to enforce

**Do not write prose describing an interface you have not run.** Six issues came from documenting
`/code-review`'s arguments from inference: a flag it does not take, then a permission allowlist
that blocked every run on Windows. Both read as confident specifications. Both were guesses.

The order is **script, run it, then write the prose** — never the reverse. A procedure with one
right answer belongs in `scripts/`, where it can be executed; the file that describes it should
say *read the script* rather than restating it.

## `/code-review`

- **The effort level is positional and comes first** — before the flags, before the target.
  `/code-review medium 9 --comment`. Everything after the level and flags is read as the review
  target, so `/code-review 9 medium` makes `9 medium` the target and takes no level.
- **`--effort <level>` is not an argument it has.** It is ignored in silence.
- **An absent level reuses the last level typed**, from an earlier session even — it does not
  default to anything.
- **A level passed in a `-p` run does not update that memory**, so the remembered level is not a
  record of what has been run. Never read it as one.
- **A bare PR number resolves against the working directory's repository.** The directory is the
  target; there is no flag that redirects it.
- **A narrow level can read less, not just report less.** A `low` pass has declined test and
  fixture hunks and said so in its scope note. Whether that is deterministic is unestablished.

## `claude -p`

- **Exit 0 proves nothing.** A session that explains why it could not proceed has succeeded by its
  own lights: exit `0`, `"is_error": false`, `"subtype": "success"`, nothing done.
- **`permission_denials` in the JSON envelope is the only record** that anything was refused.
  Non-empty is a block. It catches permissions nobody thought to allow, which is why the allowlist
  does not have to be right in advance.
- **A prefix grant cannot match composed shell.** `Bash(gh api:*)` never matches
  `SHA=$(gh pr view …) && gh api …`. And no `Bash(…)` rule reaches the `PowerShell` tool at all,
  which is what the reviewer uses on Windows. Grant bare tool names; deny what must not happen,
  because deny is evaluated before the mode and before any allow.

## `spawnSync`

- **`shell: true` concatenates argv unescaped** — Node warns as much — and on Windows it breaks on
  the executable path before it reaches the arguments. There is no `shell: true` fallback anywhere
  in this repository and there should not be one.
- **`shell: false` will not execute a `.cmd`, and returns empty stdout with no error.** That is
  why PATH stubbing is not a testing option here: a stub would fail silently and a test would read
  the silence as a result.

## Testing

**`scripts/lib/exec.mjs` holds the only `spawnSync` call.** Everything takes `run` as an argument;
tests pass `fakeRun`, which records the argv it was given and fails loudly on an unscripted call.

**Never mock `node:child_process`.** It is not ours — a module mock keeps passing while the code
breaks — and ESM module mocking in `node:test` still needs an experimental flag with open defects.

**Assert argv construction first.** Every real bug in this repository lived there.

**Use the real thing where it is local and cheap.** `branch.mjs` is tested against real git in a
temp directory. Faking git would only test that we remember what git does, which is the thing we
would get wrong.

**CI has no `gh` auth and no `claude`.** Green means the logic is sound, never that the reviewer
works. Only a live run establishes that, which is what the run log records.

## The run log

Every script appends to `~/.claude/baton/runs/<owner>__<repo>.jsonl`, machine-written and free.
`BATON_HOME` relocates it. Draining it is `/baton:audit`'s job — a log nobody dispositions is how
a friction log dies.
