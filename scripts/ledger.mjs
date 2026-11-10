#!/usr/bin/env node
// The epic's ledger: every agent a session dispatched, with what it cost. Run it at every handback and at the end of
// every wave; the orchestrator copies its rows into run.md rather than estimating. Reads files only, costs no tokens.
//
//   node ledger.mjs <session-dir> [--since <ISO>] [--until <ISO>] [--json]
//   node ledger.mjs --project <project-dir> --since <ISO> --until <ISO>      every session in a project folder
//   node ledger.mjs <session-dir> --waves <waves.json> [--wave <name>]       slice and total by wave
//   node ledger.mjs <session-dir> --agent <id-or-name-fragment>              one line, for a handback
//   node ledger.mjs --self [--waves <waves.json>]   one line: this session's last context and, with waves, whether to hand off
//   node ledger.mjs --all --since <ISO> --until <ISO> --clip                 every session on the machine, cut to the window
//   node ledger.mjs ... --clip                                                count only turns inside --since/--until
//   node ledger.mjs ... --percentiles                                         count, median, p90 and max of units per role and model
//   node ledger.mjs --handoffs <run.md> [--next <session-dir>]               the handoff decisions logged in run.md; with --next, the first yes against that session
//   node ledger.mjs ... --pace                                                per step: rounds and minutes; flags 2+ rounds and a builder past twice the builders' median
//   node ledger.mjs <session-dir> --time [--all]                              per step, wave and epic: where the minutes went (transcript split, event log, orchestrator latency); --all lists every step
//   node ledger.mjs ... --strict                                             exit 1 on a warning
//
// --self finds this session by CLAUDE_CODE_SESSION_ID in every project folder, so it works from any directory; with no
// id it falls back to the newest transcript in this directory's project folder. --all with --clip is how a retro
// calibrates: the week's units over the meter's percent.
//
// <session-dir> is ~/.claude/projects/<project>/<session-id>/ (its subagents/ and workflows/ are scanned); the
// session's own transcript, <session-id>.jsonl beside it, is counted as the orchestrator. waves.json is
// {"w1": {"from": "<ISO>", "to": "<ISO>", "budgetUnits": 5000000}}; an agent belongs to the wave its first turn
// falls in. Warnings (an agent past the context ceiling or its role's unitTarget, or the unitTargetByModel of the model that ran, a wave past its budget) print to stderr; exit 1 only with
// --strict. Cost units and the weights behind them are in references/roles.json.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { summarize, mainModel, instant } from './lib/transcript.mjs'
import { loadRoles, units, show, familyOf } from './lib/roles.mjs'
import { stepOf, reasonOf } from './lib/steps.mjs'
import { timeSplit, transcriptMerges } from './lib/timing.mjs'
import { timeReport } from './lib/time-report.mjs'
import { readEvents, heavyFallbackPath, EVENTS_FILE } from './lib/events.mjs'

export { stepOf }

function agents(dir) {
  const rows = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl')) rows.push(path)
    }
  }
  for (const sub of ['subagents', 'workflows']) if (existsSync(join(dir, sub))) walk(join(dir, sub))
  return rows
}

export function describe(path, summary) {
  const meta = path.replace(/\.jsonl$/, '.meta.json')
  if (existsSync(meta)) {
    try {
      const m = JSON.parse(readFileSync(meta, 'utf8'))
      if (m.description) return m.description
    } catch {}
  }
  return summary.prompt.split('\n')[0].slice(0, 60) || '(no description)'
}

// An agent's role is the first word of the description it was dispatched with ("fix: w3 round 2"), when that word is
// a key of the role table; any other description has no role and no target.
export function roleOf(description, roles = loadRoles()) {
  const word = String(description).trim().split(/[\s:]/)[0].toLowerCase()
  return Object.hasOwn(roles.roles, word) ? word : null
}

export const tokensOf = (s) => s.input + s.cacheRead + s.cacheWrite + s.output

// One agent's row. Shared by the ledger and the SubagentStop hook.
export function agentRow(s, { id, name, roles = loadRoles() }) {
  const model = mainModel(s).replace(/^claude-/, '')
  return {
    agent: name,
    id,
    role: name === 'orchestrator' ? 'orchestrator' : roleOf(name, roles),
    model,
    turns: s.turns,
    peakContext: s.peakContext,
    lastContext: s.lastContext,
    input: s.input,
    cacheRead: s.cacheRead,
    cacheWrite: s.cacheWrite,
    output: s.output,
    tokens: tokensOf(s),
    units: units(s, model, roles),
    start: s.first,
    end: s.last,
    minutes: s.first && s.last ? Math.round((instant(s.last) - instant(s.first)) / 60000) : null,
  }
}

// With clip, turns outside [since, until) are not counted at all; without it an agent is in or out whole.
// With time, each row also carries its transcript's time split and its subject line (for `--time`).
export function ledger(dir, since, until, roles = loadRoles(), clip = false, { time = false } = {}) {
  const rows = []
  const main = join(dirname(dir), `${basename(dir)}.jsonl`)
  const files = existsSync(main) && statSync(main).isFile() ? [main, ...agents(dir)] : agents(dir)
  for (const path of files) {
    const s = summarize(path, clip ? { since, until } : undefined)
    if (!s || s.turns === 0) continue
    if (since && s.last && instant(s.last) < instant(since)) continue
    if (until && s.first && instant(s.first) > instant(until)) continue
    const row = agentRow(s, {
      id: path === main ? basename(dir) : basename(path, '.jsonl').replace(/^agent-/, ''),
      name: path === main ? 'orchestrator' : describe(path, s),
      roles,
    })
    if (time) Object.assign(row, { time: timeSplit(path), subject: s.prompt.split('\n')[0].trim() })
    rows.push(row)
  }
  return rows.sort((a, b) => b.units - a.units)
}

// Every session in a project folder: a <session>.jsonl, with or without a <session>/ folder of agents beside it.
export function projectLedger(projectDir, since, until, roles = loadRoles(), clip = false) {
  const ids = new Set()
  for (const e of readdirSync(projectDir, { withFileTypes: true })) {
    if (e.isDirectory()) ids.add(e.name)
    else if (e.name.endsWith('.jsonl')) ids.add(basename(e.name, '.jsonl'))
  }
  const rows = []
  for (const id of ids) rows.push(...ledger(join(projectDir, id), since, until, roles, clip))
  return rows.sort((a, b) => b.units - a.units)
}

const projectsRoot = (home) => join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')

// Every project folder on the machine. The weekly meter counts all of them, so calibration reads all of them.
export function allLedger(since, until, roles = loadRoles(), clip = false, home = homedir()) {
  const root = projectsRoot(home)
  if (!existsSync(root)) return []
  const rows = []
  for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) rows.push(...projectLedger(join(root, e.name), since, until, roles, clip))
  return rows.sort((a, b) => b.units - a.units)
}

// This session: CLAUDE_CODE_SESSION_ID, looked up in every project folder, since the orchestrator's shell is often in
// another directory (run from the epic's root it printed the usage line and nothing else). With no id, the newest
// transcript in the working directory's project folder, which with two sessions open in one directory may be the other.
export function selfSession(cwd, home = homedir()) {
  const root = projectsRoot(home)
  if (!existsSync(root)) return null
  const id = process.env.CLAUDE_CODE_SESSION_ID
  if (id) {
    const own = join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'))
    for (const folder of [own, ...readdirSync(root).map((n) => join(root, n))]) if (existsSync(join(folder, `${id}.jsonl`))) return join(folder, id)
  }
  const project = join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'))
  if (!existsSync(project)) return null
  const newest = readdirSync(project).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, t: statSync(join(project, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]
  return newest ? join(project, basename(newest.f, '.jsonl')) : null
}

// The orchestrator's own line. Every turn re-reads the last context, so that, not the peak, is what continuing costs; a
// compaction resets it and the peak stays. With waves, the most recent wave's turn count stands in for the next wave's:
// handing off would re-read (last - freshSessionTokens) fewer tokens on each of them. Hand off when that saving is at
// least handoff.minimumUnitsSaved.
export function selfLine(sessionDir, waves = {}, roles = loadRoles(), now = new Date()) {
  const main = `${sessionDir}.jsonl`
  const s = summarize(main)
  if (!s || s.turns === 0) return null
  const model = mainModel(s).replace(/^claude-/, '')
  const kt = (n) => `${Math.round(n / 1000)}k`
  const head = `orchestrator ${basename(sessionDir)}: last context ${kt(s.lastContext)} (each turn re-reads it), peak ${kt(s.peakContext)}, ${s.turns} turns.`
  const named = Object.entries(waves).sort((a, b) => instant(a[1].from) - instant(b[1].from))
  if (!named.length) return { line: `${head} Pass --waves <file> for the handoff estimate.`, handOff: null, log: null }
  const [name, wave] = named[named.length - 1]
  const turns = summarize(main, { since: wave.from, until: wave.to }).turns
  const { freshSessionTokens, minimumUnitsSaved } = roles.handoff
  const saved = units({ cacheRead: Math.max(0, s.lastContext - freshSessionTokens) * turns }, model, roles)
  const handOff = saved >= minimumUnitsSaved
  return {
    line: `${head} Wave ${name}: ${turns} turns; a fresh session starts near ${kt(freshSessionTokens)}, and over as many turns ` +
      `would save ${show(saved, roles)}. Hand off at the wave boundary: ${handOff ? 'yes' : 'no'} (threshold ${show(minimumUnitsSaved, roles)}).`,
    handOff,
    log: `handoff-decision at=${now.toISOString()} session=${basename(sessionDir)} wave=${name} last_context=${s.lastContext} turns=${turns} predicted_units=${saved} handed_off=${handOff ? 'yes' : 'no'}`,
  }
}

// The decision lines selfLine printed and the orchestrator pasted into run.md, read back.
export function parseHandoffs(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const at = line.indexOf('handoff-decision ')
    if (at < 0) continue
    const f = Object.fromEntries([...line.slice(at).matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]))
    if (!f.session || !f.wave) continue
    out.push({ at: f.at, session: f.session, wave: f.wave, lastContext: Number(f.last_context), turns: Number(f.turns), predictedUnits: Number(f.predicted_units), handedOff: f.handed_off === 'yes' })
  }
  return out
}

// A decision against what happened: the saving the rule predicted, and the one the next session's own first turns show,
// which is what the old session would have re-read beyond the new one's mean context over the same number of turns.
export function handoffCheck(decision, nextSessionDir, roles = loadRoles()) {
  const s = summarize(`${nextSessionDir}.jsonl`, { maxTurns: decision.turns })
  if (!s || s.turns === 0) return null
  const model = mainModel(s).replace(/^claude-/, '')
  const meanContext = Math.round((s.input + s.cacheRead + s.cacheWrite) / s.turns)
  return {
    nextTurns: s.turns,
    meanContext,
    predictedUnits: decision.predictedUnits,
    actualUnits: units({ cacheRead: Math.max(0, decision.lastContext - meanContext) * s.turns }, model, roles),
  }
}

// Count, median, 90th percentile (nearest rank) and maximum of agent units, per role and model family. A retro sets the
// role targets from these.
export function rolePercentiles(rows, roles = loadRoles()) {
  const groups = {}
  for (const r of rows) if (r.role) (groups[`${r.role} ${familyOf(r.model, roles)}`] ??= []).push(r.units)
  const rank = (a, p) => a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)]
  return Object.fromEntries(Object.entries(groups).map(([k, u]) => {
    u.sort((a, b) => a - b)
    return [k, { n: u.length, median: rank(u, 0.5), p90: rank(u, 0.9), max: u.at(-1) }]
  }))
}

// Per step: rounds (fix agents, plus cold reads after the first), and minutes from the first dispatch to the last
// handback. Flags a step on two rounds or more, and a builder past twice the median minutes of the builders. Read from
// the rows the ledger already has; nothing is measured that was not.
export function pace(rows) {
  const word = (r) => String(r.agent).trim().split(/[\s:]/)[0].toLowerCase()
  const steps = new Map()
  const reasons = {}
  for (const r of rows) {
    const key = stepOf(r.agent)
    if (!key) continue
    const s = steps.get(key) ?? { key, fix: 0, cold: 0, start: Infinity, end: -Infinity }
    if (word(r) === 'fix') { s.fix += 1; reasons[reasonOf(r.agent)] = [...(reasons[reasonOf(r.agent)] ?? []), key] }
    if (word(r) === 'cold-read') s.cold += 1
    s.start = Math.min(s.start, instant(r.start))
    s.end = Math.max(s.end, instant(r.end))
    steps.set(key, s)
  }
  const out = [...steps.values()].map((s) => ({ step: s.key, rounds: s.fix + Math.max(0, s.cold - 1), minutes: Number.isFinite(s.end - s.start) ? Math.round((s.end - s.start) / 60000) : null }))
  const flags = out.filter((s) => s.rounds >= 2).map((s) => `${s.step}: ${s.rounds} rounds, a tool or brief gap to build before the next agent of that role`)
  for (const [reason, keys] of Object.entries(reasons)) {
    if (reason !== 'other' && keys.length >= 2) flags.push(`${reason}: ${keys.length} fix rounds (${keys.join(', ')}) for one reason, a tool or brief gap to build before the next agent of that role`)
  }
  const builders = rows.filter((r) => word(r) === 'builder' && r.minutes != null).sort((a, b) => a.minutes - b.minutes)
  if (builders.length) {
    const median = builders[Math.min(builders.length - 1, Math.ceil(builders.length / 2) - 1)].minutes
    for (const b of builders) if (b.minutes > 2 * median) flags.push(`${b.agent} (${b.id}): ${b.minutes} min, past twice the builder median of ${median}`)
  }
  return { steps: out, flags, reasons: Object.fromEntries(Object.entries(reasons).map(([r, k]) => [r, k.length])) }
}

export function inWave(row, wave) {
  return instant(row.start) >= instant(wave.from) && (!wave.to || instant(row.start) < instant(wave.to))
}

export function waveTotals(rows, waves) {
  return Object.entries(waves).map(([name, w]) => {
    const mine = rows.filter((r) => inWave(r, w))
    return { name, agents: mine.length, units: mine.reduce((n, r) => n + r.units, 0), budget: w.budgetUnits ?? null }
  })
}

export function warnings(rows, totals, ceiling, roles = loadRoles()) {
  const out = []
  for (const r of rows) {
    const role = r.role && roles.roles[r.role]
    const target = role && (role.unitTargetByModel?.[familyOf(r.model, roles)] ?? role.unitTarget)
    if (target && r.units > target) out.push(`${r.agent} (${r.id}) used ${k(r.units)} units, past the ${k(target)} unit target of its role ${r.role}${role.unitTargetByModel?.[familyOf(r.model, roles)] ? ` on ${familyOf(r.model, roles)}` : ''}`)
    if (r.agent !== 'orchestrator' && r.peakContext > ceiling) out.push(`${r.agent} (${r.id}) peaked at ${Math.round(r.peakContext / 1000)}k context, past the ${Math.round(ceiling / 1000)}k ceiling`)
  }
  for (const t of totals) if (t.budget && t.units > t.budget) out.push(`wave ${t.name} used ${t.units} units against a budget of ${t.budget}`)
  return out
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)

export function markdown(rows, totals = [], roles = loadRoles()) {
  const lines = ['| agent | model | turns | peak ctx | cache read | cache write | output | units | min |', '|---|---|---|---|---|---|---|---|---|']
  for (const r of rows) lines.push(`| ${r.agent.replace(/\|/g, '/')} | ${r.model} | ${r.turns} | ${k(r.peakContext)} | ${k(r.cacheRead)} | ${k(r.cacheWrite)} | ${k(r.output)} | ${k(r.units)} | ${r.minutes ?? ''} |`)
  const by = {}
  for (const r of rows) {
    by[r.model] ??= { agents: 0, cacheRead: 0, cacheWrite: 0, output: 0, units: 0 }
    by[r.model].agents += 1
    for (const f of ['cacheRead', 'cacheWrite', 'output', 'units']) by[r.model][f] += r[f]
  }
  lines.push('', '| model | agents | cache read | cache write | output | units |', '|---|---|---|---|---|---|')
  for (const [m, t] of Object.entries(by)) lines.push(`| ${m} | ${t.agents} | ${k(t.cacheRead)} | ${k(t.cacheWrite)} | ${k(t.output)} | ${k(t.units)} |`)
  const total = rows.reduce((n, r) => n + r.units, 0)
  lines.push('', `Total: ${show(total, roles)}`)
  if (totals.length) {
    lines.push('', '| wave | agents | units | budget | |', '|---|---|---|---|---|')
    for (const t of totals) lines.push(`| ${t.name} | ${t.agents} | ${k(t.units)} | ${t.budget ? k(t.budget) : 'unset'} | ${t.budget && t.units > t.budget ? 'OVER' : ''} |`)
  }
  return lines.join('\n')
}

const matches = (r, fragment) => r.id.startsWith(fragment) || r.agent.toLowerCase().includes(fragment.toLowerCase())

// The line the orchestrator pastes above an agent's own handback block.
export function agentLine(rows, fragment) {
  const hits = rows.filter((r) => matches(r, fragment))
  if (hits.length !== 1) return null
  const r = hits[0]
  return `${r.agent} (${r.id}): ${r.model}, ${r.turns} turns, peak context ${k(r.peakContext)}, ${k(r.units)} units, ${r.minutes ?? '?'} min`
}

export function main(args) {
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const valued = new Set(['--since', '--until', '--waves', '--wave', '--agent', '--project', '--handoffs', '--next'])
  const dir = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))
  const projectDir = flag('--project')
  if (flag('--handoffs')) {
    const roles = loadRoles()
    const decisions = parseHandoffs(readFileSync(flag('--handoffs'), 'utf8'))
    for (const d of decisions) console.log(`${d.at} ${d.session} ${d.wave}: last context ${Math.round(d.lastContext / 1000)}k, ${d.turns} turns, predicted ${k(d.predictedUnits)} units, handed off ${d.handedOff ? 'yes' : 'no'}`)
    const next = flag('--next')
    const yes = decisions.find((d) => d.handedOff)
    if (next && yes) {
      const c = handoffCheck(yes, next, roles)
      console.log(c ? `against ${basename(next)}: its first ${c.nextTurns} turns averaged ${Math.round(c.meanContext / 1000)}k context; saving predicted ${k(c.predictedUnits)} units, shown ${k(c.actualUnits)}` : `no turns in ${next}.jsonl`)
    }
    if (!decisions.length) console.error(`no handoff-decision lines in ${flag('--handoffs')}`)
    return decisions.length ? 0 : 2
  }
  const timed = args.includes('--time')
  const all = args.includes('--all') && !timed
  const self = args.includes('--self')
  const target = self ? dir || selfSession(process.cwd()) : projectDir || dir
  if (!all && (!target || !(existsSync(target) || existsSync(`${target}.jsonl`)))) {
    console.error('usage: ledger.mjs <session-dir> | --project <project-dir> | --all | --self  [--since <ISO>] [--until <ISO>] [--clip] [--waves <file> [--wave <name>]] [--agent <fragment>] [--json] [--strict]')
    return 2
  }
  const roles = loadRoles()
  const waves = flag('--waves') ? JSON.parse(readFileSync(flag('--waves'), 'utf8')) : {}
  if (self) {
    const out = selfLine(target, waves, roles)
    if (!out) {
      console.error(`no turns in ${target}.jsonl`)
      return 2
    }
    console.log(out.line)
    if (out.log) console.log(out.log)
    return 0
  }
  const wave = flag('--wave') ? waves[flag('--wave')] : undefined
  if (flag('--wave') && !wave) {
    console.error(`no wave "${flag('--wave')}" in ${flag('--waves') || '(no --waves file given)'}`)
    return 2
  }
  const since = wave ? wave.from : flag('--since')
  const until = wave ? wave.to : flag('--until')
  const clip = args.includes('--clip')
  let rows = all ? allLedger(since, until, roles, clip) : projectDir ? projectLedger(projectDir, since, until, roles, clip) : ledger(target, since, until, roles, clip, { time: timed })
  if (wave) rows = rows.filter((r) => inWave(r, wave))
  if (flag('--agent')) {
    const line = agentLine(rows, flag('--agent'))
    if (!line) {
      console.error(`--agent ${flag('--agent')} matched ${rows.filter((r) => matches(r, flag('--agent'))).length} agents, need exactly one`)
      return 2
    }
    console.log(line)
    return 0
  }
  if (timed) {
    const session = basename(target)
    const stamps = rows.map((r) => instant(r.start)).filter(Number.isFinite)
    const window = [Math.min(...stamps) - 60000, Math.max(...rows.map((r) => instant(r.end)).filter(Number.isFinite)) + 60000]
    const own = readEvents(join(target, EVENTS_FILE))
    const loose = readEvents(heavyFallbackPath()).filter((e) => (!e.session || e.session === session) && instant(e.at) >= window[0] && instant(e.at) <= window[1])
    const report = timeReport({ rows, events: [...own, ...loose], merges: transcriptMerges(`${target}.jsonl`), all: args.includes('--all'), session: session.slice(0, 8) })
    console.log(report.lines.join('\n'))
    return 0
  }
  if (args.includes('--pace')) {
    const p = pace(rows)
    for (const s of p.steps.sort((a, b) => b.rounds - a.rounds || (b.minutes ?? 0) - (a.minutes ?? 0))) console.log(`${s.step}: ${s.rounds} rounds, ${s.minutes ?? '?'} min`)
    const why = Object.entries(p.reasons).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')
    if (why) console.log(`fix rounds by reason: ${why}`)
    for (const f of p.flags) console.log(`slow: ${f}`)
    if (!p.steps.length) console.error('no agent description names a step ("w3 s07b" or "w0 #641")')
    return 0
  }
  if (args.includes('--percentiles')) {
    for (const [key, p] of Object.entries(rolePercentiles(rows, roles))) console.log(`${key}: n ${p.n}, median ${k(p.median)}, p90 ${k(p.p90)}, max ${k(p.max)}`)
    return 0
  }
  const totals = waveTotals(rows, wave ? { [flag('--wave')]: wave } : waves)
  console.log(args.includes('--json') ? JSON.stringify({ rows, waves: totals }, null, 2) : markdown(rows, totals, roles))
  const warns = warnings(rows, totals, roles.ceilingTokens, roles)
  for (const w of warns) console.error(`warning: ${w}`)
  return warns.length && args.includes('--strict') ? 1 : 0
}

if (process.argv[1] && basename(process.argv[1]) === 'ledger.mjs') process.exit(main(process.argv.slice(2)))
