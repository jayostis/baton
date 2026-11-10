#!/usr/bin/env node
// Caps the agents running at once by weight, in an epic only. Four hooks, one argument each:
//
//   check   PreToolUse on Agent. Refuses a dispatch that would pass `heavy_agents` (builders, fixers) or `light_agents`
//           (readers, reviewers) and records one that fits. Its stderr names the running agents of that weight.
//   bound   PostToolUse on Agent. The dispatch cannot know the new agent's id, but its result does: a background launch
//           gets the id bound to its entry, a foreground one has finished and its entry goes.
//   stop    SubagentStop. Removes the entry by id, or by description when the id was never bound.
//   reset   SessionStart (a start or a resume). A restart kills every agent in flight, so what is recorded is dead.
//
// The entries are one file in the session's folder (scripts/lib/machine.mjs); one that has gone 90 minutes with no write
// to its agent's transcript, or 6 hours in all, is dropped as it is read. BATON_MACHINE=0 turns the hooks off.
// Exit 0 lets the call through; exit 2 blocks it and its stderr goes back to the session as the reason.

import { readFileSync, existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { loadRoles } from './lib/roles.mjs'
import { inEpic } from './epic-mode.mjs'
import { verdict as modelVerdict } from './require-model.mjs'
import { limits, readMachineSection, machineOff, weightOf, statePath, updateState, writeState, live } from './lib/machine.mjs'

const minutes = (ms) => `${Math.round(ms / 60000)} min`

// `running` is the live entries. Returns whether to block, why, and the entry to record when the dispatch fits.
export function verdict(input, { env = process.env, epic = inEpic(input.session_id, env), running = [], lim = limits({ env }), roles = loadRoles(), now = Date.now() } = {}) {
  if (input.tool_name !== 'Agent' || machineOff(env) || !epic) return { block: false }
  const description = String(input.tool_input?.description || '').trim()
  const weight = weightOf(description, roles)
  const same = running.filter((a) => a.weight === weight)
  const cap = weight === 'heavy' ? lim.heavy_agents : lim.light_agents
  if (same.length >= cap) {
    const list = same.map((a) => `${a.description || a.id} (${minutes(now - a.at)})`).join('; ')
    return {
      block: true,
      reason: `Not dispatched: ${same.length} ${weight} agents are running and the cap is ${cap}, from the project config's machine section or this machine's ${lim.cpus} cpus and memory: ${list}. Wait for a handback, then dispatch.`,
    }
  }
  return { block: false, entry: { id: input.tool_use_id || null, agent_id: null, description: description || '(no description)', weight, at: now } }
}

function agentIdOf(response) {
  if (response && typeof response === 'object') return response.agentId ?? null
  return /agentId["':\s=]+([A-Za-z0-9_-]+)/.exec(String(response ?? ''))?.[1] ?? null
}

function metaDescription(transcriptPath) {
  try { return JSON.parse(readFileSync(transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description || null } catch { return null }
}

// The state change each hook makes, from the entries before it. Pure, so the tests run it without a file.
export function apply(mode, input, agents, now = Date.now()) {
  if (mode === 'bound') {
    const response = input.tool_response
    const done = response && typeof response === 'object' && response.status === 'completed'
    const id = agentIdOf(response)
    if (done) return agents.filter((a) => a.id !== input.tool_use_id)
    return agents.map((a) => (a.id === input.tool_use_id && id ? { ...a, agent_id: id } : a))
  }
  if (mode === 'stop') {
    let gone = agents.findIndex((a) => a.agent_id && a.agent_id === input.agent_id)
    if (gone < 0) {
      const d = input.agent_transcript_path && metaDescription(input.agent_transcript_path)
      gone = d ? agents.findIndex((a) => !a.agent_id && a.description === d) : -1
    }
    return gone < 0 ? agents : agents.filter((_, i) => i !== gone)
  }
  return agents
}

export const resets = (input) => !['compact', 'clear'].includes(input.source)

if (process.argv[1] && basename(process.argv[1]) === 'agent-slots.mjs') {
  const mode = process.argv[2]
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { process.exit(0) }
  try {
    const path = statePath(input)
    if (machineOff()) process.exit(0)
    if (mode === 'reset') {
      if (resets(input) && existsSync(dirname(path))) writeState(path, [])
    } else if (mode === 'check') {
      if (!inEpic(input.session_id) || modelVerdict(input).block) process.exit(0)
      const lim = limits({ config: readMachineSection(process.env, input.cwd) })
      let result
      updateState(path, (all) => {
        const running = live(all, Date.now(), dirname(path))
        result = verdict(input, { running, lim })
        return { agents: result.entry ? [...running, result.entry] : running }
      })
      if (result.block) { console.error(result.reason); process.exit(2) }
    } else if (mode === 'bound' || mode === 'stop') {
      if (existsSync(path)) updateState(path, (all) => ({ agents: apply(mode, input, all) }))
    }
  } catch {}
}
