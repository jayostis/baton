# Retro

Run it when the walk is done, in the orchestrator session, and finish with one PR. Nothing here updates itself.

1. **Ledger.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs <session-dir> --waves <epic>/waves.json`. Keep its tables
   and the total units.
2. **History.** Append this epic to the project's `epics.csv` and compare with the rows above it. Where
   this epic is far from the others, say which agent or round explains it. `node ${CLAUDE_PLUGIN_ROOT}/scripts/history.mjs --spec <file>
   --out <epics.csv> --append` computes the row from a spec (the header of `scripts/history.mjs` has its fields); you
   supply merged PRs and the walk's defect count. A second row for one epic needs its own spec file: two rows with
   one `match` tie, and a tie drops the session from both.
3. **Handbacks.** Read every handback block in `run.md`: the waits, what cost a round, the proposed changes. Count
   proposals made more than once.
4. **Calibrate.** Ask the maintainer for `/usage`: the week's percent and the session's lines per model. Run
   `ledger.mjs --all --since <the week's reset> --until <the reading> --clip`; `unitsPerPercentOfWeek` is its units
   over the percent, and an earlier reading in the same week checks it. Check the weights against the session's dollars
   and the list prices. Change either only with the reason, in its note.
5. **Handoffs and targets.** `ledger.mjs --handoffs <run.md> --next <the next session-dir>` sets the first logged
   handoff against the next session: predicted saving, and the one its first turns show. Recalibrate
   `freshSessionTokens` and `minimumUnitsSaved` from the gap. A logged *no* is checked against the next wave's actual turns.
   `ledger.mjs <session-dir> --percentiles` gives each role's p90 by model; reset each `unitTarget` and
   `unitTargetByModel` to it, saying the sample size.
6. **Edit, one PR**, on a branch of baton. A problem that recurred is fixed by a check nobody has to choose to read: a
   hook, a script the loop already calls (`gate.sh`, `wait-ci.sh`, `dispatch.mjs`, `ledger.mjs`) or a test. A line in
   `references/lessons.md` only where no check is possible, ending `(no check: <why>)`; a lesson a check now covers, or
   whose reason no longer holds, is deleted. A test holds both and the cap. Models and targets change only for the ledger.
7. **Test and open.** `node --test test/*.test.mjs`. The PR body lists each change with the number behind it and ends
   with what the maintainer must decide. The maintainer merges. Delete the run folder when the epic closes.
