// What the machine can carry, and which agents and commands count against it. An agent's cost to the machine depends on
// what it runs, not on how many agents there are: authors, reviewers and readers wait on the model, builders and fixers
// run builds and tests. So the limits are two caps on agents by weight (references/roles.json, each role's `local`)
// and a number of slots for the heavy local commands (scripts/heavy.sh). The project config's `machine` section sets
// them; without it they come from this machine's cpus and memory.

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { join, dirname } from 'node:path'
import { batonHome } from './runlog.mjs'
import { loadRoles } from './roles.mjs'

export const HEAVY_COMMANDS = [
  'pytest', 'node --test', 'npm test', 'npm run test', 'npm run lint', 'npx vitest', 'vitest', 'npx tsc -b', 'tsc -b',
  'cargo (test|nextest|build)', 'docker run', 'playwright', 'npm run build',
]

export const STALE_AGENT_MS = 90 * 60 * 1000
export const MAX_AGENT_MS = 6 * 60 * 60 * 1000

// The `## machine` section of a project config: lines of `key: value`, optionally bulleted, values optionally in backticks.
export function machineSection(text) {
  const out = {}
  let inside = false
  for (const line of String(text).split('\n')) {
    const heading = /^#{1,6}\s*(.*?)\s*$/.exec(line)
    if (heading) { inside = heading[1].toLowerCase() === 'machine'; continue }
    if (!inside) continue
    const kv = /^\s*(?:[-*]\s*)?`?([a-z_]+)`?\s*:\s*(.*?)\s*$/.exec(line)
    if (kv && kv[2] !== '') out[kv[1]] = kv[2].replace(/^`+|`+$/g, '')
  }
  return out
}

export function projectConfigPath(env = process.env, cwd = process.cwd()) {
  const named = env.BATON_PROJECT_CONFIG || env.CLAUDE_PLUGIN_OPTION_PROJECT_CONFIG
  if (named) return named
  const local = join(cwd, '.baton', 'project.md')
  return existsSync(local) ? local : null
}

export function readMachineSection(env = process.env, cwd = process.cwd()) {
  const path = projectConfigPath(env, cwd)
  try { return path ? machineSection(readFileSync(path, 'utf8')) : {} } catch { return {} }
}

const positive = (v) => (/^\d+$/.test(String(v ?? '')) && Number(v) > 0 ? Number(v) : null)

// heavy_slots: one per four logical cpus and one per 4 GB of memory beyond a 4 GB reserve for the sessions, whichever is
// fewer, at least one. heavy_agents: one more than the slots, so a heavy agent is always starting or finishing while the
// others run. light_agents: 10. The config's value wins, and BATON_HEAVY_SLOTS / _AGENTS / BATON_LIGHT_AGENTS over it.
export function limits({ config = {}, env = process.env, cpuCount = cpus().length, memBytes = totalmem() } = {}) {
  const gb = memBytes / 2 ** 30
  const byMachine = Math.max(1, Math.min(Math.floor(cpuCount / 4), Math.floor((gb - 4) / 4)))
  const heavy_slots = positive(env.BATON_HEAVY_SLOTS) ?? positive(config.heavy_slots) ?? byMachine
  const heavy_agents = positive(env.BATON_HEAVY_AGENTS) ?? positive(config.heavy_agents) ?? heavy_slots + 1
  const light_agents = positive(env.BATON_LIGHT_AGENTS) ?? positive(config.light_agents) ?? 10
  const heavy_commands = config.heavy_commands ? config.heavy_commands.split(',').map((s) => s.trim()).filter(Boolean) : HEAVY_COMMANDS
  return { heavy_slots, heavy_agents, light_agents, heavy_commands, cpus: cpuCount }
}

export const machineOff = (env = process.env) => env.BATON_MACHINE === '0'

// Heavy or light, by the first word of a dispatch description ("fix: w3 s07b round 2"): the role table's `local`, else
// defaultLocal for keys the table lacks (author, checker, cold-read, retro), else light.
export function weightOf(description, roles = loadRoles()) {
  const word = String(description || '').trim().split(/[\s:]/)[0].toLowerCase()
  const role = Object.hasOwn(roles.roles, word) ? roles.roles[word].local : roles.defaultLocal?.[word]
  return role === 'heavy' ? 'heavy' : 'light'
}

// ---- running agents: one JSON file in the session's folder, written by the hooks in scripts/agent-slots.mjs

export function statePath(input, home = batonHome()) {
  if (input.transcript_path) return join(String(input.transcript_path).replace(/\.jsonl$/, ''), 'baton-agents.json')
  return join(home, 'machine', `${String(input.session_id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

export function readState(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(s.agents) ? s.agents : []
  } catch { return [] }
}

export function writeState(path, agents) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ agents }))
}

// Hooks of parallel dispatches run as parallel processes: a read-modify-write goes under a mkdir lock.
export function updateState(path, change) {
  const lock = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  let held = false
  for (let i = 0; i < 100 && !held; i++) {
    try { mkdirSync(lock); held = true } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { recursive: true, force: true }) } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    const result = change(readState(path))
    writeState(path, result.agents)
    return result
  } finally { if (held) rmSync(lock, { recursive: true, force: true }) }
}

// An entry is dropped when its agent's transcript has not been written for 90 minutes (a bound entry; one not yet bound
// has only its dispatch time), and always when it is older than 6 hours.
export function live(agents, now, sessionDir, mtimeOf = (p) => { try { return statSync(p).mtimeMs } catch { return null } }) {
  return agents.filter((a) => {
    if (now - a.at > MAX_AGENT_MS) return false
    const wrote = a.agent_id && sessionDir ? mtimeOf(join(sessionDir, 'subagents', `agent-${a.agent_id}.jsonl`)) : null
    return now - Math.max(a.at, wrote ?? 0) <= STALE_AGENT_MS
  })
}
