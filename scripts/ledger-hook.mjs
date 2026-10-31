#!/usr/bin/env node
// SubagentStop hook: appends the finished agent's ledger row to the run log, so what each agent cost is on record the
// moment it stops, whether or not the orchestrator ran the ledger. Its input names the agent's transcript
// (agent_transcript_path). It never blocks and never fails the stop: anything it cannot read is skipped.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { summarize } from './lib/transcript.mjs'
import { appendRun } from './lib/runlog.mjs'
import { agentRow, describe } from './ledger.mjs'

export function rowOf(input) {
  const path = input.agent_transcript_path
  const s = path && summarize(path)
  if (!s || s.turns === 0) return null
  return agentRow(s, { id: input.agent_id || basename(path, '.jsonl').replace(/^agent-/, ''), name: describe(path, s) })
}

if (process.argv[1] && basename(process.argv[1]) === 'ledger-hook.mjs') {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    const row = rowOf(input)
    if (row) appendRun('ledger', basename(input.cwd || 'unknown'), { session: input.session_id ?? null, agentType: input.agent_type ?? null, ...row })
  } catch {}
}
