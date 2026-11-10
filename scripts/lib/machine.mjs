// What the machine can carry, and which agents count against it. An agent's cost to the machine depends on what it runs,
// not on how many agents there are: authors, reviewers and readers wait on the model, builders and fixers run builds and
// tests. So the limits are two caps on agents by weight (references/roles.json, each role's `local`) and a number of
// slots for the heavy local commands (scripts/heavy.sh). The project config's `machine` section sets them; without it
// they come from this machine's cpus and memory.

import { readFileSync, existsSync, writeFileSync, readdirSync, statSync, renameSync } from 'node:fs'
import { cpus, totalmem, tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRoles } from './roles.mjs'

export const STALE_AGENT_MS = 90 * 60 * 1000

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
  return { heavy_slots, heavy_agents, light_agents, cpus: cpuCount }
}

export const machineOff = (env = process.env) => env.BATON_MACHINE === '0'

// Heavy or light, by the first word of a dispatch description ("fix: w3 s07b round 2"): the role table's `local`, else
// defaultLocal for keys the table lacks (author, checker, cold-read, retro), else light.
export function weightOf(description, roles = loadRoles()) {
  const word = String(description || '').trim().split(/[\s:]/)[0].toLowerCase()
  const role = Object.hasOwn(roles.roles, word) ? roles.roles[word].local : roles.defaultLocal?.[word]
  return role === 'heavy' ? 'heavy' : 'light'
}

// ---- the limits file. heavy.sh runs in a shell where the plugin's options are not set, so it cannot read the project
// config the hooks read; the dispatch hook writes what it resolved here, and `machine.mjs` reads it back.

export const limitsFilePath = (env = process.env) => env.BATON_MACHINE_FILE || join(tmpdir(), 'baton-machine.json')

export function writeLimitsFile(lim, env = process.env, now = Date.now()) {
  const path = limitsFilePath(env)
  const tmp = `${path}.${process.pid}`
  writeFileSync(tmp, JSON.stringify({ ...lim, at: now }))
  renameSync(tmp, path)
}

// The three limits the file holds, as strings the way a config section gives them; {} when absent or unreadable.
export function readLimitsFile(env = process.env) {
  try {
    const f = JSON.parse(readFileSync(limitsFilePath(env), 'utf8'))
    return Object.fromEntries(['heavy_slots', 'heavy_agents', 'light_agents'].filter((k) => positive(f[k])).map((k) => [k, String(f[k])]))
  } catch { return {} }
}

// ---- the agents running now, from Claude Code's own files: <session-dir>/subagents/agent-<id>.meta.json holds the
// dispatch's description and `"finished": true` once the agent has handed back, and agent-<id>.jsonl is its transcript. An
// agent is running when it has not finished and its transcript was written in the last 90 minutes: that is also what ages
// out the agents a restart killed, which never get a `finished`. A session with no subagents folder has none running; any
// other error throws, and the caller lets the dispatch through.
export function runningAgents(sessionDir, { now = Date.now(), roles = loadRoles(), exceptToolUse = null } = {}) {
  const dir = join(sessionDir, 'subagents')
  let names
  try { names = readdirSync(dir) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  const out = []
  for (const name of names) {
    if (!/^agent-.+\.meta\.json$/.test(name)) continue
    const meta = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    if (meta.finished === true || (exceptToolUse && meta.toolUseId === exceptToolUse)) continue
    let wrote
    try { wrote = statSync(join(dir, name.replace(/\.meta\.json$/, '.jsonl'))).mtimeMs } catch { wrote = statSync(join(dir, name)).mtimeMs }
    if (now - wrote > STALE_AGENT_MS) continue
    const description = String(meta.description || '').trim()
    out.push({ id: name.slice('agent-'.length, -'.meta.json'.length), description: description || '(no description)', weight: weightOf(description, roles), quietMs: now - wrote })
  }
  return out
}
