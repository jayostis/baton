#!/usr/bin/env node
// PreToolUse hook on SubagentHandback, in an epic only: a walk agent cannot hand back until its message reports every
// numbered item of its input as walked or not walked (walk-check.mjs). The walk is the agent whose dispatch description
// key is `walk`; its input is its prompt's line 3. Its transcript is the hook's transcript_path when that is the agent's
// own, else <session-dir>/subagents/agent-<agent_id>.jsonl. Anything it cannot find or read is let through.
// Exit 2 blocks the handback and its stderr goes back to the agent as the reason.

import { readFileSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { inEpic } from './epic-mode.mjs'
import { keyOf } from './lib/steps.mjs'
import { walkOf, verdictLine, walkItems } from './walk-check.mjs'

export function agentTranscript(input) {
  const tp = input.transcript_path ? String(input.transcript_path) : null
  if (!tp) return null
  if (/^agent-.+\.jsonl$/.test(basename(tp))) return tp
  if (!input.agent_id) return null
  return join(dirname(tp), basename(tp, '.jsonl'), 'subagents', `agent-${input.agent_id}.jsonl`)
}

export function verdict(input, { env = process.env, epic = inEpic(input.session_id, env) } = {}) {
  if (input.tool_name !== 'SubagentHandback' || !epic) return { block: false }
  const path = agentTranscript(input)
  if (!path || !existsSync(path)) return { block: false }
  const meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
  if (keyOf(meta.description) !== 'walk') return { block: false }
  const { input: file } = walkOf(path)
  if (!file || !existsSync(file)) return { block: false }
  const text = readFileSync(file, 'utf8')
  if (!walkItems(text).length) return { block: false }
  const v = verdictLine(text, input.tool_input?.message ?? '')
  if (v.ok) return { block: false }
  return {
    block: true,
    reason: `Not handed back: ${v.line} (${file}). Report every numbered item of the input on a line of its own, "<n>. walked: <what you saw>" or "<n>. not walked: <why>", then hand back again.`,
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'walk-hook.mjs') {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { process.exit(0) }
  try {
    const result = verdict(input)
    if (result.block) { console.error(result.reason); process.exit(2) }
  } catch {}
}
