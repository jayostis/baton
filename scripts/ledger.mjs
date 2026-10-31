#!/usr/bin/env node
// The epic's ledger: every agent a session dispatched, with what it cost. Run it at every handback and at the end of
// every wave; the orchestrator copies its rows into run.md rather than estimating. Reads files only, costs no tokens.
//
//   node ledger.mjs <session-dir> [--since <ISO>] [--until <ISO>] [--json]
//   node ledger.mjs --project <project-dir> --since <ISO> --until <ISO>      every session in a project folder
//   node ledger.mjs <session-dir> --waves <waves.json> [--wave <name>]       slice and total by wave
//   node ledger.mjs <session-dir> --agent <id-or-name-fragment>              one line, for a handback
//   node ledger.mjs --self        the newest session in this directory's project folder; with two sessions open in one
//                                 directory it may be the other, so pass the session dir then
//   node ledger.mjs ... --strict                                              exit 1 on a warning
//
// <session-dir> is ~/.claude/projects/<project>/<session-id>/ (its subagents/ and workflows/ are scanned); the
// session's own transcript, <session-id>.jsonl beside it, is counted as the orchestrator. waves.json is
// {"w1": {"from": "<ISO>", "to": "<ISO>", "budgetUnits": 5000000}}; an agent belongs to the wave its first turn
// falls in. Warnings (an agent past the context ceiling, a wave past its budget) print to stderr; exit 1 only with
// --strict. Cost units and the weights behind them are in references/roles.json.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { summarize, mainModel } from './lib/transcript.mjs'
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

function describe(path, summary) {
  const meta = path.replace(/\.jsonl$/, '.meta.json')
  if (existsSync(meta)) {
    try {
      const m = JSON.parse(readFileSync(meta, 'utf8'))
      if (m.description) return m.description
    } catch {}
  }
  return summary.prompt.split('\n')[0].slice(0, 60) || '(no description)'
}

// With clip, turns outside [since, until) are not counted at all; without it an agent is in or out whole.
export function ledger(dir, since, until, roles = loadRoles(), clip = false) {
  const rows = []
  const main = join(dirname(dir), `${basename(dir)}.jsonl`)
  const files = existsSync(main) && statSync(main).isFile() ? [main, ...agents(dir)] : agents(dir)
  for (const path of files) {
    const s = summarize(path, clip ? { since, until } : undefined)
    if (!s || s.turns === 0) continue
    if (since && s.last && s.last < since) continue
    if (until && s.first && s.first > until) continue
    const model = mainModel(s).replace(/^claude-/, '')
    rows.push({
      agent: path === main ? 'orchestrator' : describe(path, s),
      id: path === main ? basename(dir) : basename(path, '.jsonl').replace(/^agent-/, ''),
      model,
      turns: s.turns,
      peakContext: s.peakContext,
      lastContext: s.lastContext,
      input: s.input,
      cacheRead: s.cacheRead,
      cacheWrite: s.cacheWrite,
      output: s.output,
      units: units(s, model, roles),
      start: s.first,
      end: s.last,
      minutes: s.first && s.last ? Math.round((Date.parse(s.last) - Date.parse(s.first)) / 60000) : null,
    })
  }
  return rows.sort((a, b) => b.units - a.units)
}

// Every session in a project folder: a <session>.jsonl, with or without a <session>/ folder of agents beside it.
export function projectLedger(projectDir, since, until, roles = loadRoles()) {
  const ids = new Set()
  for (const e of readdirSync(projectDir, { withFileTypes: true })) {
    if (e.isDirectory()) ids.add(e.name)
    else if (e.name.endsWith('.jsonl')) ids.add(basename(e.name, '.jsonl'))
  }
  const rows = []
  for (const id of ids) rows.push(...ledger(join(projectDir, id), since, until, roles))
  return rows.sort((a, b) => b.units - a.units)
}

// The session in this working directory: the newest transcript in its project folder, which is the one being written.
export function selfSession(cwd, home = homedir()) {
  const project = join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  if (!existsSync(project)) return null
  const newest = readdirSync(project).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, t: statSync(join(project, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]
  return newest ? join(project, basename(newest.f, '.jsonl')) : null
}

export function inWave(row, wave) {
  return row.start >= wave.from && (!wave.to || row.start < wave.to)
}

export function waveTotals(rows, waves) {
  return Object.entries(waves).map(([name, w]) => {
    const mine = rows.filter((r) => inWave(r, w))
    return { name, agents: mine.length, units: mine.reduce((n, r) => n + r.units, 0), budget: w.budgetUnits ?? null }
  })
}

export function warnings(rows, totals, ceiling) {
  const out = []
  for (const r of rows) {
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
  const target = args.includes('--self') ? selfSession(process.cwd()) : projectDir || dir
  if (!target || !(existsSync(target) || existsSync(`${target}.jsonl`))) {
    console.error('usage: ledger.mjs <session-dir> | --project <project-dir>  [--since <ISO>] [--until <ISO>] [--waves <file> [--wave <name>]] [--agent <fragment>] [--json] [--strict]')
    return 2
  }
  const roles = loadRoles()
  const waves = flag('--waves') ? JSON.parse(readFileSync(flag('--waves'), 'utf8')) : {}
  const wave = flag('--wave') ? waves[flag('--wave')] : undefined
  if (flag('--wave') && !wave) {
    console.error(`no wave "${flag('--wave')}" in ${flag('--waves') || '(no --waves file given)'}`)
    return 2
  }
  const since = wave ? wave.from : flag('--since')
  const until = wave ? wave.to : flag('--until')
  let rows = projectDir ? projectLedger(projectDir, since, until, roles) : ledger(target, since, until, roles)
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
  const warns = warnings(rows, totals, roles.ceilingTokens)
  for (const w of warns) console.error(`warning: ${w}`)
  return warns.length && args.includes('--strict') ? 1 : 0
}

if (process.argv[1] && basename(process.argv[1]) === 'ledger.mjs') process.exit(main(process.argv.slice(2)))
