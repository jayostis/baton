#!/usr/bin/env node
// epics.csv rows from transcripts: what each epic cost, by the ledger's units, for the retro to compare against and for
// a backfill of epics that ran before the ledger existed. Reads files only.
//
//   node history.mjs --spec <epics.json> [--projects <dir>] [--out <file.csv>] [--append]
//
// <epics.json> is a list of {"epic": "epic-343", "from": "2026-10-16", "to": "2026-10-17", "match": "epic-343",
// "mergedPRs": 8, "walkDefects": null}. A session belongs to the epic whose `match` pattern (a regular expression)
// occurs most often in the session's own transcript; ties and sessions that name no epic are left out. A session's
// agents go with it. Only turns inside [from, to + 1 day) count, so a session that ran across several epics is cut at the dates. Units, agents and wall clock are measured; mergedPRs
// and walkDefects are supplied by whoever knows them (null stays blank). Rounds per PR is the number of fix agents
// (a description matching /fix|round|follow-?up/i) over mergedPRs, so it is a proxy; wall clock is the hours covered by
// the union of the agents' working intervals (the orchestrator's own span only when it dispatched none), so the gaps
// between agents are excluded. An epic no session names has blank agents, units and wall clock, not zeros.

import { readdirSync, readFileSync, existsSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { ledger } from './ledger.mjs'
import { loadRoles } from './lib/roles.mjs'

export const COLUMNS = ['epic', 'dates', 'agents', 'cost_units', 'merged_prs', 'units_per_pr', 'rounds_per_pr', 'walk_defects', 'wall_clock_hours']

const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)

export function dominantEpic(text, epics) {
  let best = null
  let tie = false
  for (const e of epics) {
    const n = (text.match(new RegExp(e.match, 'g')) || []).length
    if (n === 0) continue
    if (!best || n > best.n) { best = { epic: e, n }; tie = false }
    else if (n === best.n) tie = true
  }
  return best && !tie ? best.epic : null
}

export function unionHours(intervals) {
  const sorted = intervals.filter(([a, b]) => a && b).map(([a, b]) => [Date.parse(a), Date.parse(b)]).sort((x, y) => x[0] - y[0])
  let total = 0
  let cur = null
  for (const [a, b] of sorted) {
    if (!cur || a > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [a, b] }
    else cur[1] = Math.max(cur[1], b)
  }
  if (cur) total += cur[1] - cur[0]
  return total / 3600000
}

export function epicRows(projectsRoot, epics, roles = loadRoles()) {
  const lowest = epics.map((e) => e.from).sort()[0]
  const highest = nextDay(epics.map((e) => e.to).sort().at(-1))
  const got = new Map(epics.map((e) => [e.epic, []]))
  for (const proj of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const dir = join(projectsRoot, proj.name)
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const main = join(dir, f)
      if (statSync(main).mtime.toISOString().slice(0, 10) < lowest) continue
      const e = dominantEpic(readFileSync(main, 'utf8'), epics)
      if (!e) continue
      got.get(e.epic).push(...ledger(join(dir, basename(f, '.jsonl')), e.from, nextDay(e.to), roles, true))
    }
  }
  return epics.map((e) => {
    const rows = got.get(e.epic)
    const agents = rows.filter((r) => r.agent !== 'orchestrator')
    const units = rows.reduce((n, r) => n + r.units, 0)
    const fixes = agents.filter((r) => /fix|round|follow-?up/i.test(r.agent)).length
    const prs = e.mergedPRs ?? null
    return {
      epic: e.epic,
      dates: e.from === e.to ? e.from : `${e.from}..${e.to}`,
      agents: rows.length ? agents.length : null,
      cost_units: rows.length ? units : null,
      merged_prs: prs,
      units_per_pr: prs && rows.length ? Math.round(units / prs) : null,
      rounds_per_pr: prs && rows.length ? Number((fixes / prs).toFixed(2)) : null,
      walk_defects: e.walkDefects ?? null,
      wall_clock_hours: rows.length ? Number(unionHours((agents.length ? agents : rows).map((r) => [r.start, r.end])).toFixed(1)) : null,
    }
  })
}

export function csv(rows, header = true) {
  const cell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
  return (header ? [COLUMNS.join(',')] : []).concat(rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(','))).join('\n') + '\n'
}

export function main(args) {
  const flag = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
  const specPath = flag('--spec')
  if (!specPath || !existsSync(specPath)) {
    console.error('usage: history.mjs --spec <epics.json> [--projects <dir>] [--out <file.csv>] [--append]')
    return 2
  }
  const projects = flag('--projects') || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  if (!existsSync(projects)) { console.error(`no projects folder at ${projects}`); return 2 }
  const rows = epicRows(projects, JSON.parse(readFileSync(specPath, 'utf8')))
  const out = flag('--out')
  if (!out) process.stdout.write(csv(rows))
  else if (args.includes('--append') && existsSync(out)) appendFileSync(out, csv(rows, false))
  else writeFileSync(out, csv(rows))
  return 0
}

if (process.argv[1] && basename(process.argv[1]) === 'history.mjs') process.exit(main(process.argv.slice(2)))
