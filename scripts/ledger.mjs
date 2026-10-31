#!/usr/bin/env node
// The epic's ledger: every agent a session dispatched, with what it cost. Run it at every handback and at the end of
// every wave; the orchestrator copies its rows into run.md rather than estimating. Reads files only, costs no tokens.
//
//   node ledger.mjs <session-dir> [--since <ISO time>] [--json]
//
// <session-dir> is ~/.claude/projects/<project>/<session-id>/ (its subagents/ and workflows/ are scanned); the
// session's own transcript, <session-id>.jsonl beside it, is counted as the orchestrator.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { summarize, mainModel } from './lib/transcript.mjs'

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
  return summary.prompt.split('\n')[0].slice(0, 60)
}

export function ledger(dir, since) {
  const rows = []
  const main = join(dirname(dir), `${basename(dir)}.jsonl`)
  const files = existsSync(main) && statSync(main).isFile() ? [main, ...agents(dir)] : agents(dir)
  for (const path of files) {
    const s = summarize(path)
    if (!s || s.turns === 0) continue
    if (since && s.last && s.last < since) continue
    rows.push({
      agent: path === main ? 'orchestrator' : describe(path, s),
      id: path === main ? basename(dir) : basename(path, '.jsonl').replace(/^agent-/, ''),
      model: mainModel(s).replace(/^claude-/, ''),
      turns: s.turns,
      peakContext: s.peakContext,
      lastContext: s.lastContext,
      cacheRead: s.cacheRead,
      cacheWrite: s.cacheWrite,
      output: s.output,
      minutes: s.first && s.last ? Math.round((Date.parse(s.last) - Date.parse(s.first)) / 60000) : null,
    })
  }
  return rows.sort((a, b) => b.cacheRead - a.cacheRead)
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)

function markdown(rows) {
  const lines = ['| agent | model | turns | peak ctx | cache read | cache write | output | min |', '|---|---|---|---|---|---|---|---|']
  for (const r of rows) lines.push(`| ${r.agent.replace(/\|/g, '/')} | ${r.model} | ${r.turns} | ${k(r.peakContext)} | ${k(r.cacheRead)} | ${k(r.cacheWrite)} | ${k(r.output)} | ${r.minutes ?? ''} |`)
  const by = {}
  for (const r of rows) {
    by[r.model] ??= { agents: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    by[r.model].agents += 1
    for (const f of ['cacheRead', 'cacheWrite', 'output']) by[r.model][f] += r[f]
  }
  lines.push('', '| model | agents | cache read | cache write | output |', '|---|---|---|---|---|')
  for (const [m, t] of Object.entries(by)) lines.push(`| ${m} | ${t.agents} | ${k(t.cacheRead)} | ${k(t.cacheWrite)} | ${k(t.output)} |`)
  return lines.join('\n')
}

if (process.argv[1] && basename(process.argv[1]) === 'ledger.mjs') {
  const args = process.argv.slice(2)
  const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--since')
  const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : undefined
  if (!dir || !existsSync(dir)) {
    console.error('usage: ledger.mjs <session-dir> [--since <ISO time>] [--json]')
    process.exit(2)
  }
  const rows = ledger(dir, since)
  console.log(args.includes('--json') ? JSON.stringify(rows, null, 2) : markdown(rows))
}
