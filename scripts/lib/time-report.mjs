// `ledger.mjs --time`: where an epic's minutes went, per step, per wave and overall. Built from what is already on disk:
// each agent's transcript split (scripts/lib/timing.mjs), the event log's heavy, CI and merge events when there is one,
// and the orchestrator's own gate.sh calls when there is not. Minutes are summed across agents that ran in parallel, so
// they say what was spent, not how long anything took on the clock; the wall column is the clock.

import { instant } from './transcript.mjs'
import { stepOf, reasonOf, refsOf } from './steps.mjs'

const MIN = 60000
// A gap from a handback to the next dispatch or merge longer than this is the maintainer being away, not the orchestrator.
export const PAUSE_MIN = 120
const PARTS = [['model', 'model'], ['heavy', 'heavy'], ['ci', 'CI wait'], ['latency', 'orchestrator latency'], ['slot', 'slot wait'], ['tools', 'other tools']]

const waveOf = (key) => /^w\d+/.exec(key)?.[0] ?? 'other'
const n1 = (x) => (x >= 10 ? String(Math.round(x)) : String(Math.round(x * 10) / 10))
const units = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)
const clock = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

// The agent an event belongs to: the one it names, else the one whose run held its time, told apart by the tool call that
// held it and the command it ran, then by the working directory.
function agentFor(e, agents) {
  if (e.agent) return agents.find((a) => a.id === e.agent) ?? null
  const at = instant(e.at)
  const inside = agents.filter((a) => at >= a.time.start - 5000 && at <= a.time.end + 5000)
  if (inside.length <= 1) return inside[0] ?? null
  const needle = String(e.cmd ?? '').slice(0, 30)
  const held = inside.filter((a) => a.time.calls.some((c) => c.start - 1000 <= at && at <= c.end + 1000 && (!needle || c.text.includes(needle))))
  const pool = held.length ? held : inside
  const cwd = String(e.cwd ?? '').replace(/\\/g, '/').toLowerCase()
  return (cwd && pool.find((a) => a.time.calls.some((c) => c.text.replace(/\\/g, '/').toLowerCase().includes(cwd)))) || pool[0]
}

export function timeReport({ rows, events = [], merges = [], all = false, session = '', maxLines = 25 }) {
  const agents = rows.filter((r) => r.time && r.role !== 'orchestrator')
  if (!agents.length) return { lines: ['no agent transcripts with timestamps'], steps: [], epic: null }
  const keyOf = (a) => stepOf(a.agent) ?? '(no step)'
  const launched = new Map()
  const dispatched = new Map()
  const handedBack = new Map()
  for (const e of events) {
    if (e.kind === 'launched' && e.agent && e.tool_use_id) launched.set(e.agent, e.tool_use_id)
    else if (e.kind === 'dispatch' && e.tool_use_id) dispatched.set(e.tool_use_id, instant(e.at))
    else if (e.kind === 'handback' && e.agent) handedBack.set(e.agent, instant(e.at))
  }
  const steps = new Map()
  const get = (key) => {
    if (!steps.has(key)) steps.set(key, { key, agents: [], start: Infinity, end: -Infinity, wall: 0, model: 0, tools: 0, kinds: { heavy: 0, ci: 0, git: 0, read: 0, other: 0 }, units: 0, peak: 0, slotS: 0, cpuS: 0, machineS: 0, ciS: 0, latency: 0, rounds: 0, reasons: [], merged: null, drops: 0 })
    return steps.get(key)
  }
  const refs = new Map()
  for (const a of agents) {
    const s = get(keyOf(a))
    const t = a.time
    a.dispatchAt = Math.min(dispatched.get(launched.get(a.id)) ?? t.start, t.start)
    a.handbackAt = Math.max(handedBack.get(a.id) ?? t.end, t.end)
    s.agents.push(a)
    s.start = Math.min(s.start, a.dispatchAt)
    s.end = Math.max(s.end, a.handbackAt)
    s.wall += t.wallMs
    s.model += t.modelMs
    s.tools += t.toolMs
    for (const k of Object.keys(s.kinds)) s.kinds[k] += t.kinds[k]
    s.units += a.units
    s.peak = Math.max(s.peak, a.peakContext)
    if (a.role === 'fix') s.reasons.push(reasonOf(a.agent))
    for (const ref of refsOf(a.subject)) {
      const c = refs.get(ref) ?? new Map()
      c.set(s.key, (c.get(s.key) ?? 0) + 1)
      refs.set(ref, c)
    }
  }
  const stepOfRef = (ref) => [...(refs.get(ref) ?? new Map())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  // merges: the event log's, else the orchestrator's own gate calls
  const found = new Map()
  for (const e of [...events.filter((x) => x.kind === 'merge'), ...merges]) {
    const ref = `${e.repo}#${e.pr}`
    if (!found.has(ref)) found.set(ref, instant(e.at))
  }
  let mapped = 0
  for (const [ref, at] of found) {
    const key = stepOfRef(ref)
    if (!key) continue
    mapped += 1
    const s = steps.get(key)
    s.merged = Math.max(s.merged ?? 0, at)
  }

  // heavy and CI events, joined to the step that ran them
  const heavyEvents = events.filter((e) => e.kind?.startsWith('heavy-'))
  const ciEvents = events.filter((e) => e.kind === 'ci-wait-end')
  for (const e of heavyEvents) {
    const a = agentFor(e, agents)
    if (!a) continue
    const s = get(keyOf(a))
    if (e.kind === 'heavy-start') s.slotS += Number(e.wait_s) || 0
    if (e.kind === 'heavy-end') { s.cpuS += Number(e.cpu_s) || 0; s.machineS += Number(e.machine_cpu_s) || 0 }
  }
  for (const e of ciEvents) {
    const key = (e.pr && stepOfRef(`${e.repo}#${e.pr}`)) || (() => { const a = agentFor(e, agents); return a ? keyOf(a) : null })()
    if (key) steps.get(key).ciS += Number(e.wall_s) || 0
  }

  // the orchestrator's latency: from each handback to the next dispatch or merge of the same step
  let paused = 0
  for (const s of steps.values()) {
    if (s.key === '(no step)') continue
    const actions = [...s.agents.map((a) => a.dispatchAt), ...(s.merged ? [s.merged] : [])]
    for (const a of s.agents) {
      const next = Math.min(...actions.filter((t) => t > a.handbackAt))
      if (!Number.isFinite(next)) continue
      const gap = (next - a.handbackAt) / MIN
      if (gap > PAUSE_MIN) paused += 1
      else s.latency += gap
    }
  }

  const done = [...steps.values()].map((s) => {
    const slot = s.slotS / 60
    const ci = Math.max(s.ciS / 60, s.kinds.ci / MIN)
    const comp = {
      model: s.model / MIN,
      heavy: Math.max(0, s.kinds.heavy / MIN - slot),
      ci,
      latency: s.latency,
      slot,
      tools: (s.kinds.git + s.kinds.read + s.kinds.other) / MIN,
    }
    const end = s.merged ?? s.end
    const cpu = s.cpuS ? `${Math.round(s.cpuS)}` : s.machineS ? `~${Math.round(s.machineS)}` : '-'
    return { ...s, comp, wallMin: (end - s.start) / MIN, cpu, cpuTotal: s.cpuS || s.machineS || 0, rounds: s.agents.filter((a) => a.role === 'fix').length + Math.max(0, s.agents.filter((a) => /^cold-read\b/.test(a.agent)).length - 1) }
  })
  const sum = (list) => Object.fromEntries(PARTS.map(([k]) => [k, list.reduce((n, s) => n + s.comp[k], 0)]))
  const share = (c) => {
    const total = PARTS.reduce((n, [k]) => n + c[k], 0) || 1
    return PARTS.map(([k, label]) => `${label} ${Math.round((100 * c[k]) / total)}%`).join(', ')
  }

  const epic = sum(done)
  const total = PARTS.reduce((n, [k]) => n + epic[k], 0)
  const sinks = PARTS.map(([k, label]) => ({ k, label, min: epic[k] })).filter((x) => x.min > 0).sort((a, b) => b.min - a.min).slice(0, 3)
    .map((x, i) => {
      const worst = [...done].sort((a, b) => b.comp[x.k] - a.comp[x.k])[0]
      return `${i + 1}. ${x.label}: ${Math.round(x.min)} min (${Math.round((100 * x.min) / (total || 1))}%), most in ${worst.key} (${Math.round(worst.comp[x.k])} min)`
    })
  const byReason = {}
  for (const s of done) for (const r of s.reasons) (byReason[r] ??= []).push(s.key)
  const reasonLine = Object.entries(byReason).sort((a, b) => b[1].length - a[1].length).map(([r, ks]) => `${r} ${ks.length}${r !== 'other' && ks.length >= 2 ? ` (a gap: ${[...new Set(ks)].slice(0, 4).join(', ')}${new Set(ks).size > 4 ? ', ...' : ''})` : ''}`).join('; ')

  const first = Math.min(...agents.map((a) => a.time.start))
  const lastAt = Math.max(...agents.map((a) => a.time.end))
  const kinds = {}
  for (const e of events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
  const head = [
    `time ${session}: ${agents.length} agents, ${done.length} steps, ${clock(first)}Z to ${clock(lastAt)}Z. Events: ${Object.keys(kinds).length ? Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ') : 'none, so transcripts only'}. Merges mapped to a step: ${mapped} of ${found.size}.`,
    'Minutes. wall = clock, first dispatch to merge (* = no merge seen, to the last handback); agents, model, tools, heavy, CI, slot and latency are summed across parallel agents; cpu is seconds (~ = machine-wide upper bound).',
    '| step | wall | agents | model | tools | heavy | CI | slot | cpu | units | peak | rounds | latency |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  const waves = [...new Set(done.map((s) => waveOf(s.key)))].sort()
  const tail = [
    ...waves.map((w) => {
      const list = done.filter((s) => waveOf(s.key) === w)
      return `${w}: ${list.length} steps. ${share(sum(list))}`
    }),
    `epic: ${Math.round(total)} min. ${share(epic)}`,
    ...sinks.map((l) => `sink ${l}`),
    ...(reasonLine ? [`fix rounds by reason: ${reasonLine}`] : []),
    ...(paused ? [`${paused} handback(s) waited over ${PAUSE_MIN} min for the next action, left out of latency (the maintainer away).`] : []),
  ]
  const rowsOut = [...done].sort((a, b) => b.wallMin - a.wallMin)
  const room = all ? rowsOut.length : Math.max(5, maxLines - head.length - tail.length - 1)
  const lines = rowsOut.slice(0, room).map((s) => `| ${s.key} | ${Math.round(s.wallMin)}${s.merged ? '' : '*'} | ${Math.round(s.wall / MIN)} | ${Math.round(s.comp.model)} | ${Math.round(s.tools / MIN)} | ${n1(s.comp.heavy)} | ${n1(s.comp.ci)} | ${n1(s.comp.slot)} | ${s.cpu} | ${units(s.units)} | ${Math.round(s.peak / 1000)}k | ${s.rounds}${s.reasons.length ? ` ${[...new Set(s.reasons)].join(',')}` : ''} | ${Math.round(s.comp.latency)} |`)
  if (rowsOut.length > room) lines.push(`... ${rowsOut.length - room} more steps (--all)`)
  return { lines: [...head, ...lines, ...tail], steps: done, epic: { minutes: epic, share: share(epic), sinks } }
}
