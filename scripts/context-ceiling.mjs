#!/usr/bin/env node
// PreToolUse hook on SendMessage: refuses to send another round to an agent whose context is past the ceiling.
// Continuing a large agent re-reads all of it on every turn; in the care-gaps epic five builders resumed four to nine
// times at 400-600k context were three quarters of a 1.1B-token day. A fresh agent given the findings and the branch
// costs a fraction (58k against 208k, epic 343). The ceiling is BATON_CONTEXT_CEILING tokens, 200000 by default.
//
// Exit 0 lets the message through; exit 2 blocks it and its stderr goes back to the session as the reason.
// Anything it cannot resolve (a peer session, a teammate, a missing transcript) is let through.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { summarize } from './lib/transcript.mjs'

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
  if (!summary || summary.lastContext <= ceiling) return { block: false }
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
  const result = verdict(input, Number(process.env.BATON_CONTEXT_CEILING) || 200000)
  if (result.block) {
    console.error(result.reason)
    process.exit(2)
  }
}
