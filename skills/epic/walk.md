# Walk

The epic's PRs are merged. You use what shipped, the way a person would, because tests did not find the defects the
walks of earlier epics found. Read this, the epic's issues (each "Done when"), and the `[walk]` and `[all]` lines of
`references/lessons.md`.

- Be alone on the machine: no other agent is running. The orchestrator guarantees it; if you see one, stop.
- Start from a clean checkout of each merged branch, built the way a user builds it. Not your worktree.
- Drive the real surface: the UI in a browser, the CLI in a shell, the API with real requests, on real or
  realistic data. For each issue, do its "Done when" first, then what a user would do next.
- Save a screenshot or output for every finding, under the path the prompt names (no spaces in the path).
- A finding is something that does not match its issue or surprises a user. Each becomes an issue with a
  "Done when" and a one-line cause if you have one. Do not fix anything.
- Count them: the retro records defects found by the walk.

Return the list of issues filed, the count, and what you could not walk and why. Then the block in
`references/handback.md`.
