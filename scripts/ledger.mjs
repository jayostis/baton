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
//   node ledger.mjs ... --strict                                              exit 1 on a warning
//
// --self finds this session by CLAUDE_CODE_SESSION_ID in every project folder, so it works from any directory; with no
// id it falls back to the newest transcript in this directory's project folder. --all with --clip is how a retro
// calibrates: the week's units over the meter's percent.
//
// <session-dir> is ~/.claude/projects/<project>/<session-id>/ (its subagents/ and workflows/ are scanned); the
// session's own transcript, <session-id>.jsonl beside it, is counted as the orchestrator. waves.json is
// {"w1": {"from": "<ISO>", "to": "<ISO>", "budgetUnits": 5000000}}; an agent belongs to the wave its first turn
// falls in. Warnings (an agent past the context ceiling or its role's unitTarget, a wave past its budget) print to stderr; exit 1 only with
// --strict. Cost units and the weights behind them are in references/roles.json.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { summarize, mainModel, instant } from './lib/transcript.mjs'
import { loadRoles, units, show } from './lib/roles.mjs'

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
export function ledger(dir, since, until, roles = loadRoles(), clip = false) {
  const rows = []
  const main = join(dirname(dir), `${basename(dir)}.jsonl`)
  const files = existsSync(main) && statSync(main).isFile() ? [main, ...agents(dir)] : agents(dir)
  for (const path of files) {
    const s = summarize(path, clip ? { since, until } : undefined)
    if (!s || s.turns === 0) continue
    if (since && s.last && instant(s.last) < instant(since)) continue
    if (until && s.first && instant(s.first) > instant(until)) continue
    rows.push(agentRow(s, {
      id: path === main ? basename(dir) : basename(path, '.jsonl').replace(/^agent-/, ''),
      name: path === main ? 'orchestrator' : describe(path, s),
      roles,
    }))
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
export function selfLine(sessionDir, waves = {}, roles = loadRoles()) {
  const main = `${sessionDir}.jsonl`
  const s = summarize(main)
  if (!s || s.turns === 0) return null
  const model = mainModel(s).replace(/^claude-/, '')
  const kt = (n) => `${Math.round(n / 1000)}k`
  const head = `orchestrator ${basename(sessionDir)}: last context ${kt(s.lastContext)} (each turn re-reads it), peak ${kt(s.peakContext)}, ${s.turns} turns.`
  const named = Object.entries(waves).sort((a, b) => instant(a[1].from) - instant(b[1].from))
  if (!named.length) return { line: `${head} Pass --waves <file> for the handoff estimate.`, handOff: null }
  const [name, wave] = named[named.length - 1]
  const turns = summarize(main, { since: wave.from, until: wave.to }).turns
  const { freshSessionTokens, minimumUnitsSaved } = roles.handoff
  const saved = units({ cacheRead: Math.max(0, s.lastContext - freshSessionTokens) * turns }, model, roles)
  const handOff = saved >= minimumUnitsSaved
  return {
    line: `${head} Wave ${name}: ${turns} turns; a fresh session starts near ${kt(freshSessionTokens)}, and over as many turns ` +
      `would save ${show(saved, roles)}. Hand off at the wave boundary: ${handOff ? 'yes' : 'no'} (threshold ${show(minimumUnitsSaved, roles)}).`,
    handOff,
  }
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
    const target = r.role && roles.roles[r.role]?.unitTarget
    if (target && r.units > target) out.push(`${r.agent} (${r.id}) used ${k(r.units)} units, past the ${k(target)} unit target of its role ${r.role}`)
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
  const valued = new Set(['--since', '--until', '--waves', '--wave', '--agent', '--project'])
  const dir = args.find((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))
  const projectDir = flag('--project')
  const all = args.includes('--all')
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
  let rows = all ? allLedger(since, until, roles, clip) : projectDir ? projectLedger(projectDir, since, until, roles, clip) : ledger(target, since, until, roles, clip)
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
  const totals = waveTotals(rows, wave ? { [flag('--wave')]: wave } : waves)
  console.log(args.includes('--json') ? JSON.stringify({ rows, waves: totals }, null, 2) : markdown(rows, totals, roles))
  const warns = warnings(rows, totals, roles.ceilingTokens, roles)
  for (const w of warns) console.error(`warning: ${w}`)
  return warns.length && args.includes('--strict') ? 1 : 0
}

if (process.argv[1] && basename(process.argv[1]) === 'ledger.mjs') process.exit(main(process.argv.slice(2)))
