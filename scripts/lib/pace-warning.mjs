// The pace flags at dispatch time: what `ledger.mjs --pace` and `--time` would say, as at most three lines for the
// orchestrator's context when a flag is up. Read from files only, and cheap by construction: an agent's row needs only
// its meta.json and the first and last timestamp of its transcript, not a token count, and what is read is cached beside
// the session, keyed by the newest mtime of every input. Nothing here blocks; the caller treats an error as no warning.
//
// The flags: this dispatch's step is on its second or later round; a round reason has come up twice with no `Sharpened`
// line in the run log since; an agent of the role being dispatched ran past twice that role's median; a slot wait over
// ten minutes in the current wave.

import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync, writeFileSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pace, overruns } from '../ledger.mjs'
import { stepOf, reasonOf, keyOf } from './steps.mjs'
import { EVENTS_FILE, readEvents, heavyFallbackPath } from './events.mjs'
import { projectConfigPath } from './machine.mjs'

export const CACHE_FILE = 'baton-pace.json'
export const SLOT_WAIT_FLAG_S = 600
const MAX_LOOSE_EVENTS_BYTES = 5 * 1024 * 1024
const MIN = 60000

const stamp = (line) => { try { const t = Date.parse(JSON.parse(line).timestamp); return Number.isFinite(t) ? t : NaN } catch { return NaN } }

// The first and last timestamp of a transcript, read from its two ends.
export function endsOf(path, head = 16384, tail = 65536) {
  const fd = openSync(path, 'r')
  try {
    const size = statSync(path).size
    const read = (from, length) => { const b = Buffer.alloc(length); const n = readSync(fd, b, 0, length, from); return b.toString('utf8', 0, n).split('\n') }
    const first = read(0, Math.min(head, size)).map(stamp).find(Number.isFinite)
    const last = read(Math.max(0, size - tail), Math.min(tail, size)).map(stamp).filter(Number.isFinite).at(-1)
    return Number.isFinite(first) && Number.isFinite(last) ? [first, last] : null
  } finally { closeSync(fd) }
}

// One row per agent in <session-dir>/subagents, in the shape `pace` and `overruns` read.
export function quickRows(sessionDir) {
  const dir = join(sessionDir, 'subagents')
  const rows = []
  for (const name of readdirSync(dir)) {
    if (!/^agent-.+\.meta\.json$/.test(name)) continue
    let meta
    try { meta = JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { continue }
    let ends = null
    try { ends = endsOf(join(dir, name.replace(/\.meta\.json$/, '.jsonl'))) } catch {}
    if (!ends) continue
    rows.push({
      agent: String(meta.description || ''),
      id: name.slice('agent-'.length, -'.meta.json'.length),
      start: new Date(ends[0]).toISOString(),
      end: new Date(ends[1]).toISOString(),
      minutes: Math.round((ends[1] - ends[0]) / MIN),
      finished: meta.finished === true,
    })
  }
  return rows
}

// The epic's run folder: a `.../notes/...` or `.../steps/...` path in the dispatch prompt names it, else the newest folder
// under the project config's `run_folders` that has a run.md. null when neither finds one.
export function runFolder(input, env = process.env) {
  const prompt = String(input.tool_input?.prompt ?? '')
  for (const m of prompt.matchAll(/((?:[A-Za-z]:)?[^\s"'`<>|*?]+?)[\\/](?:notes|steps)[\\/]/g)) if (existsSync(join(m[1], 'run.md'))) return m[1]
  const config = projectConfigPath(env, input.cwd)
  if (!config) return null
  let text
  try { text = readFileSync(config, 'utf8') } catch { return null }
  const inside = text.split(/^#{1,6}\s*run_folders\s*$/m)[1]?.split(/^#{1,6}\s/m)[0] ?? ''
  const root = /([^\s`]*?)[\\/]?<epic>/.exec(inside)?.[1]
  if (!root || !existsSync(root)) return null
  let best = null
  for (const name of readdirSync(root)) {
    try { const t = statSync(join(root, name, 'run.md')).mtimeMs; if (!best || t > best.t) best = { t, dir: join(root, name) } } catch {}
  }
  return best?.dir ?? null
}

const mtime = (p) => { try { return statSync(p).mtimeMs } catch { return 0 } }

// Everything the flags are read from, as one analysis. It does not depend on the dispatch being made, so it can be cached.
export function analyse({ sessionDir, folder }) {
  const rows = quickRows(sessionDir)
  let unhandled = null
  let wave = null
  if (folder) {
    try {
      const text = readFileSync(join(folder, 'run.md'), 'utf8')
      const at = [...text.matchAll(/\bSharpened\b/gi)].at(-1)?.index ?? -1
      const before = at < 0 ? '' : text.slice(0, at)
      unhandled = rows.filter((r) => /^fix\b/.test(r.agent.trim().toLowerCase()) && !before.includes(r.id)).map((r) => r.id)
    } catch {}
    try {
      const waves = Object.entries(JSON.parse(readFileSync(join(folder, 'waves.json'), 'utf8'))).map(([name, w]) => ({ name, from: Date.parse(w.from) })).filter((w) => Number.isFinite(w.from))
      wave = waves.sort((a, b) => b.from - a.from)[0] ?? null
    } catch {}
  }
  let slotWaitS = 0
  if (wave) {
    const session = basename(sessionDir)
    const loose = heavyFallbackPath()
    const looseEvents = existsSync(loose) && statSync(loose).size <= MAX_LOOSE_EVENTS_BYTES ? readEvents(loose).filter((e) => !e.session || e.session === session) : []
    for (const e of [...readEvents(join(sessionDir, EVENTS_FILE)), ...looseEvents]) {
      if (e.kind === 'heavy-wait' && Date.parse(e.at) >= wave.from) slotWaitS = Math.max(slotWaitS, Number(e.wait_s) || 0)
    }
  }
  return { rows, unhandled, wave: wave?.name ?? null, slotWaitS }
}

// The cache key: how many agent files there are and the newest mtime among them and the other inputs.
export function cacheKey(sessionDir, folder) {
  const dir = join(sessionDir, 'subagents')
  let n = 0
  let newest = 0
  for (const name of readdirSync(dir)) {
    if (!/^agent-.+\.(jsonl|meta\.json)$/.test(name)) continue
    n += 1
    newest = Math.max(newest, mtime(join(dir, name)))
  }
  for (const p of [join(sessionDir, EVENTS_FILE), heavyFallbackPath(), ...(folder ? [join(folder, 'run.md'), join(folder, 'waves.json')] : [])]) newest = Math.max(newest, mtime(p))
  return `${n}:${newest}:${folder ?? ''}`
}

export function analysisFor(sessionDir, folder) {
  const key = cacheKey(sessionDir, folder)
  const file = join(sessionDir, CACHE_FILE)
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'))
    if (c.key === key) return { ...c.analysis, cached: true }
  } catch {}
  const analysis = analyse({ sessionDir, folder })
  try {
    const tmp = `${file}.${process.pid}`
    writeFileSync(tmp, JSON.stringify({ key, analysis }))
    renameSync(tmp, file)
  } catch {}
  return analysis
}

const times = (o) => `${Math.round((10 * o.minutes) / o.median) / 10}x`

// The lines to add for this dispatch, from an analysis. Empty when no flag is up.
export function flagLines(analysis, description) {
  const role = keyOf(description)
  const step = stepOf(description)
  const rows = analysis.rows
  const flags = []

  const mine = step ? pace(rows).steps.find((s) => s.step === step) : null
  if (mine && mine.rounds >= 1) {
    const reasons = {}
    for (const r of rows) {
      if (stepOf(r.agent) === step && /^fix\b/.test(r.agent.trim().toLowerCase())) reasons[reasonOf(r.agent)] = (reasons[reasonOf(r.agent)] ?? 0) + 1
    }
    const top = Object.entries(reasons).filter(([w, n]) => w !== 'other' && n >= 2).sort((a, b) => b[1] - a[1])[0]
    flags.push(`${step} at ${mine.rounds + 1} rounds${top ? `, ${top[1]} for "${top[0]}"` : ''}`)
  }

  if (analysis.unhandled) {
    const by = {}
    for (const r of rows) {
      const w = reasonOf(r.agent)
      if (analysis.unhandled.includes(r.id) && w !== 'other') (by[w] ??= []).push(stepOf(r.agent) ?? r.id)
    }
    for (const [w, steps] of Object.entries(by)) {
      if (steps.length >= 2) flags.push(`"${w}" came up ${steps.length} times (${[...new Set(steps)].slice(0, 4).join(', ')}) with no Sharpened line in the run log since`)
    }
  }

  const over = overruns(rows.filter((r) => r.finished), role).sort((a, b) => b.minutes / b.median - a.minutes / a.median).slice(0, 2)
  if (over.length) flags.push(over.map((o) => `${role} ${stepOf(o.agent) ?? o.id} at ${times(o)} median`).join(', '))

  if (analysis.slotWaitS > SLOT_WAIT_FLAG_S) flags.push(`slot waits of up to ${Math.round(analysis.slotWaitS / 60)} min in ${analysis.wave}`)

  if (!flags.length) return []
  const lines = flags.length > 3 ? [flags[0], flags[1], flags.slice(2).join('; ')] : flags
  lines[lines.length - 1] += `. Sharpen before dispatching another ${role || 'agent'}.`
  return lines.map((l) => `pace: ${l}`)
}

// The hook's whole job for a dispatch: the lines, or [] when there is nothing to say or nothing to read.
export function paceWarning(input, env = process.env) {
  if (!input.transcript_path) return []
  const sessionDir = String(input.transcript_path).replace(/\.jsonl$/, '')
  if (!existsSync(join(sessionDir, 'subagents'))) return []
  return flagLines(analysisFor(sessionDir, runFolder(input, env)), String(input.tool_input?.description ?? '').trim())
}
