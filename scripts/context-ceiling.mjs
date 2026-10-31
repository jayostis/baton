#!/usr/bin/env node
// PreToolUse hook on SendMessage: an agent that has already handed back is not resumed. A fresh agent given the
// findings and the branch costs a fraction of the resumed one (58k against 208k in one measured epic); resumed
// builders were most of an expensive day in another. A message that begins "RESUME-APPROVED:" gets through, for the
// rare correction the orchestrator decides is worth the cost. A message to an agent that is still running always
// passes, however large its context: "stop and hand back" must reach it. The ceiling (BATON_CONTEXT_CEILING tokens,
// ceilingTokens in references/roles.json by default) is named in the refusal and flagged by the ledger.
//
// Exit 0 lets the message through; exit 2 blocks it and its stderr goes back to the session as the reason.
// Anything it cannot resolve (a peer session, a teammate, a missing transcript) is let through.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { summarize, isFinished } from './lib/transcript.mjs'
import { loadRoles } from './lib/roles.mjs'

export function findAgent(sessionTranscript, to) {
  const dir = join(dirname(sessionTranscript), basename(sessionTranscript, '.jsonl'), 'subagents')
  if (!to || !existsSync(dir)) return null
  const direct = join(dir, `agent-${to}.jsonl`)
  if (existsSync(direct)) return direct
  // A name can be reused; the latest agent to carry it is the one SendMessage reaches.
  let best = null
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.meta.json')) continue
    try {
      const metaPath = join(dir, file)
      if (JSON.parse(readFileSync(metaPath, 'utf8')).name !== to) continue
      const at = statSync(metaPath).mtimeMs
      if (!best || at > best.at) best = { at, path: join(dir, file.replace(/\.meta\.json$/, '.jsonl')) }
    } catch {}
  }
  return best?.path ?? null
}

export function verdict(input, ceiling) {
  const message = input.tool_input?.message
  if (input.tool_name !== 'SendMessage' || !input.transcript_path || !message) return { block: false }
  const to = String(input.tool_input.to || '').replace(/\s*\[[^\]]*\]\s*$/, '')
  const path = findAgent(input.transcript_path, to)
  const summary = path && summarize(path)
  if (!summary || !isFinished(path) || /^\s*RESUME-APPROVED:/.test(message)) return { block: false }
  const over = summary.lastContext > ceiling ? `, past the ${Math.round(ceiling / 1000)}k ceiling` : ''
  return {
    block: true,
    reason:
      `Not sent: ${to} has already handed back (${summary.turns} turns, ${Math.round(summary.lastContext / 1000)}k context${over}), ` +
      'and a message resumes it from all of that. Start a fresh agent with the branch, the findings and the model the role table names. ' +
      'If the correction is worth the cost, begin the message with "RESUME-APPROVED:" and say why.',
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
