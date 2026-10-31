# Handback block

Every epic agent ends its report with exactly this block, after its role's report and nothing after it.

```
## Handback
- tokens: (the orchestrator adds the ledger's line here; write nothing)
- waits: <each time you waited on something: what, how long, or "none">
- cost a round: <what made a second round or a retry necessary, or "none">
- change: <the one change to the brief, a tool or the step file that would have saved the most, or "none">
```

The ledger's line has the agent, model, turns, peak context, cost units and minutes. An agent has no way to read its
own transcript, so it reports none of them; the orchestrator pastes the line from
`node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs <session-dir> --agent <id>` above the block in `run.md`. The retro reads the blocks, so keep
each line to one sentence.
