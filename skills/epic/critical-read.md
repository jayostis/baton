# Critical read

You read every step of the epic together, against the code on the integration branch, before anything is built.
Per-step grooming misses what this finds: in earlier epics every such read found must-fixes. Prompt lines: 1 the epic, 2 this file, 4 the plugin root, 5 the project config. Read this, all the step
issues, the settled list and the `[critical-read]` and `[all]` lines of `references/lessons.md`.

## Ask of the steps together

- **Seams.** Where one step's output is another's input, is the contract written down, with names? Which steps can
  start early against it, and which must wait for a review that could change it?
- **Ownership.** Do two steps edit one file or one shared scheme? Order them or split the file.
- **Readers.** Before a shared term, scheme or query is added or changed, grep every reader in every repo.
- **Checks.** Does every input go through the field that is checked? Which inputs can be empty, and what do they
  fuse into? Does each refusal fail for its own reason?
- **Premises.** Name the code path that shows each behaviour a step assumes, and check the engine can do what a lean
  assumes. Five minutes of grep each.
- **Measure first.** Which step rests on a number nobody has? Make that a step 0 on real data.
- **Local loop.** Is there a fast way to run each step's checks before the first build: an image, a host runner, a
  harness? If not, that is step 0.
- **Cost.** Which steps are design-heavy (Opus) and which are mechanical (Haiku)? Everything else is Sonnet.

## Return

At most 60 lines:

1. Must-fixes per step, each one line, ready to edit into the issue.
2. A table: step, role from the role table, wave, concurrency notes (the Docker lock, timed runs).
3. The risks no step covers, and each one's check.
4. Questions only the maintainer can answer, each with your lean.

Then the block in `references/handback.md`.
