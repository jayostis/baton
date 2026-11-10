#!/usr/bin/env node
// PreToolUse hook on Agent, in an epic only: caps the agents running at once by weight, `heavy_agents` (builders, fixers)
// and `light_agents` (readers, reviewers). It keeps no state of its own. The running agents are Claude Code's own files,
// <session-dir>/subagents/agent-*.meta.json, minus the ones marked `finished` and the ones whose transcript has not been
// written for 90 minutes (scripts/lib/machine.mjs). A fresh session starts with none. On a resume of the same session
// the agents a restart killed have no `finished` either, so they count until their 90 quiet minutes are up.
//
// One agent whose description key is `sharpen` runs past the caps. The hook fails open: any error reading or parsing
// lets the dispatch through and says so on stderr. It also refreshes the limits file heavy.sh reads.
// BATON_MACHINE=0 turns it off. Exit 0 lets the call through; exit 2 blocks it and its stderr goes back as the reason.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { loadRoles } from './lib/roles.mjs'
import { keyOf } from './lib/steps.mjs'
import { inEpic } from './epic-mode.mjs'
import { limits, readMachineSection, machineOff, weightOf, runningAgents, writeLimitsFile } from './lib/machine.mjs'

const minutes = (ms) => `${Math.round(ms / 60000)} min`

// `running` is what runningAgents returns. Returns whether to block and why.
export function verdict(input, { env = process.env, epic = inEpic(input.session_id, env), running = [], lim = limits({ env }), roles = loadRoles() } = {}) {
  if (input.tool_name !== 'Agent' || machineOff(env) || !epic) return { block: false }
  const description = String(input.tool_input?.description || '').trim()
  const weight = weightOf(description, roles)
  if (keyOf(description) === 'sharpen' && !running.some((a) => keyOf(a.description) === 'sharpen')) return { block: false }
  const same = running.filter((a) => a.weight === weight && keyOf(a.description) !== 'sharpen')
  const cap = weight === 'heavy' ? lim.heavy_agents : lim.light_agents
  if (same.length < cap) return { block: false }
  const list = same.map((a) => `${a.description} (quiet ${minutes(a.quietMs ?? 0)})`).join('; ')
  return {
    block: true,
    reason: `Not dispatched: ${same.length} ${weight} agents are running and the cap is ${cap}, from the project config's machine section or this machine's ${lim.cpus} cpus and memory: ${list}. Wait for a handback, then dispatch.`,
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'dispatch-hook.mjs') {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { process.exit(0) }
  try {
    if (input.tool_name !== 'Agent' || machineOff() || !inEpic(input.session_id)) process.exit(0)
    const lim = limits({ config: readMachineSection(process.env, input.cwd) })
    try { writeLimitsFile(lim) } catch {}
    const sessionDir = input.transcript_path ? String(input.transcript_path).replace(/\.jsonl$/, '') : null
    const running = sessionDir ? runningAgents(sessionDir, { exceptToolUse: input.tool_use_id }) : []
    const result = verdict(input, { running, lim })
    if (result.block) { console.error(result.reason); process.exit(2) }
  } catch (e) {
    console.error(`baton dispatch hook: ${e.message}; dispatch allowed`)
  }
}
