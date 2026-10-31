// epics.csv rows from transcripts: attribution of a session to an epic, wall clock as a union, and the CSV itself.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dominantEpic, unionHours, epicRows, csv, COLUMNS, main } from '../scripts/history.mjs'

const turn = (id, ctx, ts, text = '') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 1, cache_read_input_tokens: ctx - 1, output_tokens: 10 } } })

const epics = [
  { epic: 'epic-a', from: '2026-10-10', to: '2026-10-11', match: 'epic-a(?![-\\w])', mergedPRs: 2 },
  { epic: 'epic-a-b', from: '2026-10-10', to: '2026-10-11', match: 'epic-a-b(?![-\\w])', mergedPRs: null },
]

test('a session goes to the epic its transcript names most, a tie or no mention goes nowhere, and a longer name is not its prefix', () => {
  assert.equal(dominantEpic('epic-a epic-a epic-a-b', epics).epic, 'epic-a')
  assert.equal(dominantEpic('epic-a-b epic-a-b', epics).epic, 'epic-a-b')
  assert.equal(dominantEpic('epic-a epic-a-b', epics), null)
  assert.equal(dominantEpic('nothing here', epics), null)
})

test('wall clock is the union of the working intervals, so overlap counts once and a gap not at all', () => {
  const h = unionHours([['2026-10-10T00:00:00Z', '2026-10-10T02:00:00Z'], ['2026-10-10T01:00:00Z', '2026-10-10T03:00:00Z'], ['2026-10-10T10:00:00Z', '2026-10-10T11:00:00Z'], [null, null]])
  assert.equal(h, 4)
  assert.equal(unionHours([]), 0)
})

test('epicRows totals the attributed sessions and their agents inside the dates, and derives units and rounds per PR', () => {
  const root = mkdtempSync(join(tmpdir(), 'hist-'))
  const proj = join(root, 'proj')
  mkdirSync(join(proj, 's1', 'subagents'), { recursive: true })
  writeFileSync(join(proj, 's1.jsonl'), turn('m', 5000, '2026-10-10T10:00:00Z', 'working on epic-a') + '\n')
  writeFileSync(join(proj, 's1', 'subagents', 'agent-x.jsonl'), turn('x', 20000, '2026-10-10T11:00:00Z') + '\n' + turn('y', 30000, '2026-10-10T12:00:00Z') + '\n')
  writeFileSync(join(proj, 's1', 'subagents', 'agent-x.meta.json'), JSON.stringify({ description: 'Fix round for step 3' }))
  writeFileSync(join(proj, 's1', 'subagents', 'agent-span.jsonl'), turn('p', 50000, '2026-10-01T10:00:00Z') + '\n' + turn('q', 60000, '2026-10-10T13:00:00Z') + '\n' + turn('r', 70000, '2026-10-25T13:00:00Z') + '\n')
  writeFileSync(join(proj, 's1', 'subagents', 'agent-late.jsonl'), turn('z', 99999, '2026-10-20T11:00:00Z') + '\n')
  writeFileSync(join(proj, 's2.jsonl'), turn('m', 5000, '2026-10-10T10:00:00Z', 'unrelated') + '\n')
  const [a, ab] = epicRows(root, epics)
  assert.equal(a.agents, 2) // x, and span, of which only the 10-10 turn counts
  assert.ok(a.cost_units > 0 && a.units_per_pr === Math.round(a.cost_units / 2))
  assert.equal(a.rounds_per_pr, 0.5)
  assert.equal(a.wall_clock_hours, 1) // span has one turn in the window so no interval; agent x worked 11:00 to 12:00; the orchestrator's one turn and the 10-20 agent do not count
  assert.equal(a.dates, '2026-10-10..2026-10-11')
  assert.equal(ab.cost_units, null) // no session names it: blank, not zero
  assert.equal(ab.agents, null)
  assert.equal(ab.units_per_pr, null)
})

test('csv quotes what needs it, leaves null blank, and main refuses a missing spec and writes a file', () => {
  assert.equal(csv([{ epic: 'a,b', dates: 'x', agents: 1, merged_prs: null }]).split('\n')[1], '"a,b",x,1,,,,,,')
  const err = console.error
  console.error = () => {}
  try { assert.equal(main([]), 2) } finally { console.error = err }
  const root = mkdtempSync(join(tmpdir(), 'hist-'))
  mkdirSync(join(root, 'proj'))
  writeFileSync(join(root, 'spec.json'), JSON.stringify(epics))
  assert.equal(main(['--spec', join(root, 'spec.json'), '--projects', root, '--out', join(root, 'e.csv')]), 0)
  assert.equal(readFileSync(join(root, 'e.csv'), 'utf8').split('\n')[0], COLUMNS.join(','))
})
