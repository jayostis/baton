// The epic's event log: one JSON object per line, {at, kind, session, agent?, step?, ...}, appended to
// <session-dir>/baton-events.jsonl by whatever already runs at that moment (the Agent and SubagentStop hooks, heavy.sh,
// wait-ci.sh, gate.sh, mark.mjs). A mark costs one append; nothing here is read until `ledger.mjs --time`.
//
// A write never fails the thing it records. A line is one append, so concurrent writers interleave whole lines. A
// script run by a subagent has the session's id in CLAUDE_CODE_SESSION_ID, which finds the folder; with no id, or no
// transcript for it, the event goes to one machine-wide file and the report joins it by time and working directory.

import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir, cpus } from 'node:os'
import { join, dirname } from 'node:path'
import { batonHome } from './runlog.mjs'

export const EVENTS_FILE = 'baton-events.jsonl'
const NUMERIC = /(_s|_ms)$|^(exit|pr)$/

export const eventsOff = (env = process.env) => env.BATON_EVENTS === '0' || env.BATON_MACHINE === '0'

// Where a hook's input says the session's events go: beside the session's agents, else under the baton home.
export function eventsPath(input, home = batonHome()) {
  if (input.transcript_path) return join(String(input.transcript_path).replace(/\.jsonl$/, ''), EVENTS_FILE)
  return join(home, 'machine', `${String(input.session_id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')}.events.jsonl`)
}

export const heavyFallbackPath = (env = process.env) => env.BATON_HEAVY_EVENTS || join(tmpdir(), 'baton-heavy-events.jsonl')

const projectsRoot = (env, home) => join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')

// <project folder>/<session id>, found by the session's transcript, in the working directory's project folder first.
export function findSessionDir(id, cwd = process.cwd(), env = process.env, home = homedir()) {
  if (!id) return null
  const root = projectsRoot(env, home)
  if (!existsSync(root)) return null
  const own = join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'))
  let names = []
  try { names = readdirSync(root).map((n) => join(root, n)) } catch {}
  for (const folder of [own, ...names]) if (existsSync(join(folder, `${id}.jsonl`))) return join(folder, id)
  return null
}

// Where a script with no hook input writes: BATON_EVENTS_FILE, else the session's folder, else the machine-wide file.
export function scriptEventsPath(env = process.env, cwd = process.cwd(), home = homedir()) {
  if (env.BATON_EVENTS_FILE) return env.BATON_EVENTS_FILE
  const dir = findSessionDir(env.CLAUDE_CODE_SESSION_ID, cwd, env, home)
  return dir ? join(dir, EVENTS_FILE) : heavyFallbackPath(env)
}

const clip = (v) => (typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}...` : v)

export function appendEvent(path, record) {
  try {
    const rec = Object.fromEntries(Object.entries({ at: new Date().toISOString(), ...record }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, clip(v)]))
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(rec)}\n`)
    return true
  } catch { return false }
}

export function readEvents(path) {
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

// `1m2.5s` and `0m0.015s`, as bash's `times` prints them, in seconds.
export function seconds(text) {
  const m = /^(\d+)m([\d.]+)s$/.exec(String(text).trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

// bash `times` prints two lines; the second is the user and system time of the shell's waited-for children.
export function childSeconds(times) {
  const words = String(times).trim().split(/\s+/).slice(-2).map(seconds)
  return words.length === 2 && words.every(Number.isFinite) ? words[0] + words[1] : NaN
}

// Busy cpu time of the whole machine, in ms: every core's user, system and irq time. What a command cost, when the
// shell cannot say (Git Bash does not total a native child's cpu), is this over its run: an upper bound that includes
// whatever else ran then.
export const machineBusyMs = () => cpus().reduce((n, c) => n + c.times.user + c.times.sys + c.times.irq + c.times.nice, 0)

// `k=v` arguments into a record. Numbers only where the key says so (a sha of digits stays a string).
export function parsePairs(pairs) {
  const out = {}
  for (const p of pairs) {
    const at = p.indexOf('=')
    if (at < 1) continue
    const k = p.slice(0, at)
    const v = p.slice(at + 1)
    out[k] = NUMERIC.test(k) && v !== '' && Number.isFinite(Number(v)) ? Number(v) : v
  }
  return out
}

// The record a script's pairs describe: `times_before`/`times_after` become cpu_s, `busy_before` machine_cpu_s.
export function scriptRecord(kind, pairs, env = process.env, cwd = process.cwd()) {
  const f = parsePairs(pairs)
  if (f.times_after !== undefined) {
    const cpu = childSeconds(f.times_after) - (f.times_before ? childSeconds(f.times_before) : 0)
    f.cpu_s = Number.isFinite(cpu) ? Math.round(cpu * 1000) / 1000 : null
  }
  if (f.busy_before !== undefined) {
    f.machine_cpu_s = Math.max(0, Math.round((machineBusyMs() - Number(f.busy_before)) / 100) / 10)
  }
  delete f.times_before; delete f.times_after; delete f.busy_before
  return { kind, session: env.CLAUDE_CODE_SESSION_ID || null, cwd, ...f }
}

// The hooks' writer: the Agent and SubagentStop hooks pass their input, which names the session's transcript.
export function recordEvent(input, kind, fields, env = process.env) {
  if (eventsOff(env)) return false
  return appendEvent(eventsPath(input), { kind, session: input.session_id ?? null, ...fields })
}
