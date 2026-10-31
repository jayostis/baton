#!/usr/bin/env node
// PreToolUse hook on Agent, in an epic only: refuses a general-purpose dispatch that does not name its model. An agent
// with no model takes the session's default, which can be the dearest model, so an unnamed builder or reviewer costs
// several times a named cheaper one. Outside an epic (no marker from epic-mode.mjs, no BATON_EPIC=1) it lets
// everything through, as it does for any agent type that has a definition of its own (Explore, Plan, baton's agents:
// each runs on the model its definition names) and for a fork, which inherits by design.
// BATON_REQUIRE_MODEL=0 turns the hook off.
//
// Exit 0 lets the dispatch through; exit 2 blocks it and its stderr goes back to the session as the reason.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { loadRoles } from './lib/roles.mjs'
import { inEpic } from './epic-mode.mjs'

export function verdict(input, env = process.env, epic = inEpic(input.session_id, env)) {
  if (input.tool_name !== 'Agent' || env.BATON_REQUIRE_MODEL === '0' || !epic) return { block: false }
  const t = input.tool_input || {}
  if (t.model || (t.subagent_type && t.subagent_type !== 'general-purpose')) return { block: false }
  const roles = loadRoles().roles
  const table = Object.entries(roles).map(([r, v]) => `${r}=${v.model}`).join(', ')
  return {
    block: true,
    reason: `Not dispatched: no model named, so this general-purpose agent would run on the session default. Pass model explicitly, from the role table in references/roles.json (${table}).`,
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
