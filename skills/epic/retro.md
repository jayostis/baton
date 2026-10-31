# Retro

Run it when the walk is done, in the orchestrator session, and finish with one PR. Nothing here updates itself.

1. **Ledger.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs <session-dir> --waves <epic>/waves.json`. Keep the
   per-agent table, the per-wave totals and the total units.
2. **History.** Append this epic to the project's `epics.csv` (columns: epic, dates, agents, cost units, merged PRs,
   units per PR, rounds per PR, defects found by the walk, wall clock) and compare with the rows above it. Where
   this epic is far from the others, say which agent or round explains it.
3. **Handbacks.** Read every handback block in `run.md`: the waits, what cost a round, the proposed changes. Count
   proposals made more than once.
4. **Calibrate.** If `roles.json` has no calibration, ask the maintainer for the usage meter's percent over this
   epic and set `unitsPerPercentOfWeek` to this epic's units divided by it. If it has one, check the new epic against
   it and change it only with the reason.
5. **Edit, one PR.** In a clone of baton, on a branch, change `references/lessons.md`, `references/roles.json` and
   the briefs. To add a line, merge or delete one: the file has a hard cap and a test enforces it. Delete a rule whose
   reason no longer holds or that caught nothing this epic. Change a model or target only for evidence in the ledger.
6. **Test and open.** `node --test test/*.test.mjs`. The PR body lists each change with the number behind it and ends
   with what the maintainer must decide. The maintainer merges.
