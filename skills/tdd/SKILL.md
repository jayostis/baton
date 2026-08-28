---
name: tdd
description: Red-green-refactor loop for adding or changing behaviour. Write the failing test first, commit it red, then implement. Use before editing source whenever the change has behaviour — a new function, a bug fix, a changed rule.
---

# TDD

**The failing run is the proof that the test can fail.** It is free while you're writing
the test and expensive to recover afterwards — mutating the source by hand to see if a
green test goes red. That asymmetry is the whole reason for the ordering.

## Two loops, not one

Don't start at the unit. Start by asking **what would convince me this is done**, and write
*that* first — the outer loop. It comes from the spec, not the design, so you can write it
before you know how you'll build the thing. That's also why an agent can't shape it to fit
its own code: it existed first.

- **Outer loop** — one acceptance check, written first, **stays red the whole time**. Going
  green is what "done" means. It may be a unit test, a component test, or an E2E
  tagged however the project marks them.
- **Inner loop** — red/green/refactor on units underneath, until the outer one passes.

The two levels are independent, and which one is hard varies. A latent bug with no observable
behaviour has *no* possible E2E, so its unit test is the outer loop. A rendering change has an
obvious outer loop ("the mark pulses, playback loops") and units that are the hard part. Pick
the level that can actually fail; don't default to the unit.

## Inner loop

1. **Red.** Write one test for one behaviour, and run it. It must fail on the
   **assertion** — not on `ImportError`, `NameError`, or a 404. A test that fails because
   the symbol doesn't exist has proved nothing about the assertion. Stub the symbol if you
   have to, then watch the assertion fail.
2. **Commit it red.** `test: failing test for <behaviour>`. This is the artifact: if the
   test changes later, the diff shows exactly what changed and you can revert it.
3. **Green.** The minimum that passes. Don't implement past the test.
4. **Refactor.** Tests stay green; no new behaviour.
5. Repeat, one behaviour per test.

## Running while you loop

- Backend: `cd server && uv run python -m pytest <path> --no-cov`
- Frontend: `npx vitest run <path>`
- Never the full suite to iterate.

## When not to

A typo, a rename, a comment, a config value, prose. If you can describe the diff in one
sentence and it has no behaviour, skip this — and say that you skipped it.

## If the test can't be written first

**Say so, and say why.** A seam that's hard to test is a design finding, not a licence to
skip. For legacy code with no seam, write a characterisation test that pins current
behaviour, commit it green, then change the code and watch it go red.
