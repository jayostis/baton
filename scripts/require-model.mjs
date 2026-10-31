#!/usr/bin/env node
// PreToolUse hook on Agent: refuses a dispatch that does not name its model. An agent with no model takes the
// session's default, which for this user is Opus, so an unnamed builder or reviewer costs several times a named
// Sonnet one (care-gaps retro: five Opus builders, none chosen). Baton's own agents name their model in their files,
// and a fork inherits by design; both pass. BATON_REQUIRE_MODEL=0 turns the hook off.
//
// Exit 0 lets the dispatch through; exit 2 blocks it and its stderr goes back to the session as the reason.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { loadRoles } from './lib/roles.mjs'

export function verdict(input, env = process.env) {
  if (input.tool_name !== 'Agent' || env.BATON_REQUIRE_MODEL === '0') return { block: false }
  const t = input.tool_input || {}
  if (t.model || t.subagent_type === 'fork' || String(t.subagent_type || '').startsWith('baton:')) return { block: false }
  const roles = loadRoles().roles
  const table = Object.entries(roles).map(([r, v]) => `${r}=${v.model}`).join(', ')
  return {
    block: true,
    reason: `Not dispatched: no model named, so this agent would run on the session default. Pass model explicitly, from the role table in references/roles.json (${table}).`,
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'require-model.mjs') {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { process.exit(0) }
  const result = verdict(input)
  if (result.block) {
    console.error(result.reason)
    process.exit(2)
  }
}
