#!/usr/bin/env node
// PreToolUse hook on SendMessage. Two refusals, both about resuming an agent:
//   1. An agent that has already handed back is not resumed. A fresh agent given the findings and the branch costs a
//      fraction of the resumed one (58k against 208k, epic 343); in the care-gaps epic five builders resumed four to
//      nine times were three quarters of a 1.1B-token day. A message that begins "RESUME-APPROVED:" gets through, for
//      the rare correction the orchestrator decides is worth the cost.
//   2. An agent past the ceiling is not sent more work, whether or not it has handed back. The ceiling is
//      BATON_CONTEXT_CEILING tokens, ceilingTokens in references/roles.json by default.
//
// Exit 0 lets the message through; exit 2 blocks it and its stderr goes back to the session as the reason.
// Anything it cannot resolve (a peer session, a teammate, a missing transcript) is let through.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { summarize, isFinished } from './lib/transcript.mjs'
import { loadRoles } from './lib/roles.mjs'

export function findAgent(sessionTranscript, to) {
  const dir = join(dirname(sessionTranscript), basename(sessionTranscript, '.jsonl'), 'subagents')
  if (!to || !existsSync(dir)) return null
  const direct = join(dir, `agent-${to}.jsonl`)
  if (existsSync(direct)) return direct
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.meta.json')) continue
    try {
      const meta = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      if (meta.name === to) return join(dir, file.replace(/\.meta\.json$/, '.jsonl'))
    } catch {}
  }
  return null
}

export function verdict(input, ceiling) {
  if (input.tool_name !== 'SendMessage' || !input.transcript_path) return { block: false }
  const path = findAgent(input.transcript_path, input.tool_input?.to)
  const summary = path && summarize(path)
  if (!summary) return { block: false }
  const approved = /^\s*RESUME-APPROVED:/.test(input.tool_input?.message || '')
  if (!approved && isFinished(path)) {
    return {
      block: true,
      reason:
        `Not sent: ${input.tool_input.to} has already handed back (${summary.turns} turns, ${Math.round(summary.lastContext / 1000)}k context), ` +
        'and a message resumes it from all of that. Start a fresh agent with the branch, the findings and the model the role table names. ' +
        'If the correction is worth the cost, begin the message with "RESUME-APPROVED:" and say why.',
    }
  }
  if (summary.lastContext <= ceiling) return { block: false }
  return {
    block: true,
    reason:
      `Not sent: ${input.tool_input.to} is at ${Math.round(summary.lastContext / 1000)}k context ` +
      `(ceiling ${Math.round(ceiling / 1000)}k, ${summary.turns} turns so far). Every further turn re-reads all of it. ` +
      'Start a fresh agent instead: give it the branch, the findings or the handoff note, and the model the role table names.',
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'context-ceiling.mjs') {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { process.exit(0) }
  const result = verdict(input, Number(process.env.BATON_CONTEXT_CEILING) || loadRoles().ceilingTokens)
  if (result.block) {
    console.error(result.reason)
    process.exit(2)
  }
}
