// Tests for cost units, waves, slices and the two hooks. Transcripts are written to a temporary project folder in the
// shape Claude Code writes them: <project>/<session>.jsonl beside <project>/<session>/subagents/agent-<id>.jsonl.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarize, isFinished } from '../scripts/lib/transcript.mjs'
import { units, show, loadRoles } from '../scripts/lib/roles.mjs'
import { ledger, projectLedger, waveTotals, warnings, agentLine, main as ledgerMain, selfSession } from '../scripts/ledger.mjs'
import { verdict } from '../scripts/context-ceiling.mjs'
import { verdict as modelVerdict } from '../scripts/require-model.mjs'

const turn = (id, context, model = 'claude-sonnet-5-5', ts = '2026-10-30T10:00:00Z') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage: { input_tokens: 1, cache_read_input_tokens: context - 1, cache_creation_input_tokens: 0, output_tokens: 10 } } })

const handback = (id) =>
  JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'SubagentHandback', input: {} }], usage: { input_tokens: 1, cache_read_input_tokens: 999, output_tokens: 1 } } })
const toolResult = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } })
const resumed = JSON.stringify({ type: 'user', message: { role: 'user', content: 'one more thing' } })
const ended = JSON.stringify({ type: 'assistant', message: { id: 'e', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [], usage: { input_tokens: 1 } } })

function session(agents) {
  const project = mkdtempSync(join(tmpdir(), 'cost-'))
  const dir = join(project, 'sess')
  mkdirSync(join(dir, 'subagents'), { recursive: true })
  writeFileSync(join(project, 'sess.jsonl'), turn('m1', 5000, 'claude-opus-5-5') + '\n')
  for (const [id, lines, meta] of agents) {
    writeFileSync(join(dir, 'subagents', `agent-${id}.jsonl`), lines.join('\n') + '\n')
    if (meta) writeFileSync(join(dir, 'subagents', `agent-${id}.meta.json`), JSON.stringify(meta))
  }
  return { project, dir, transcript: join(project, 'sess.jsonl') }
}

const roles = {
  calibration: { unitsPerPercentOfWeek: null },
  weights: { kinds: { input: 1, cacheWrite: 1, cacheRead: 0.1, output: 5 }, models: { opus: 2, sonnet: 1, haiku: 0.5, unknown: 2 } },
}

const quiet = (fn) => {
  const log = console.log, err = console.error
  console.log = () => {}; console.error = () => {}
  try { return fn() } finally { console.log = log; console.error = err }
}

test('cost units weight each token kind and then the model; an unknown model is priced as the dearest', () => {
  const t = { input: 10, cacheWrite: 10, cacheRead: 100, output: 2 }
  assert.equal(units(t, 'sonnet-5-5', roles), 40)
  assert.equal(units(t, 'opus-5-5', roles), 80)
  assert.equal(units(t, 'haiku-4', roles), 20)
  assert.equal(units(t, 'mystery', roles), 80)
})

test('units show as a percent of the week only once the calibration is set', () => {
  assert.equal(show(2_500_000, roles), '2.5M units')
  assert.equal(show(5_000_000, { ...roles, calibration: { unitsPerPercentOfWeek: 1_000_000 } }), '5.0% of the week (5.0M units)')
})

test('the shipped roles.json has a weight for every model its roles name and a calibration with its source', () => {
  const r = loadRoles()
  assert.ok(r.calibration.unitsPerPercentOfWeek > 0)
  assert.match(r.calibration.note, /meter/)
  for (const [role, v] of Object.entries(r.roles)) assert.ok(r.weights.models[v.model], `${role} names ${v.model}, which has no weight`)
})

test('ledger rows carry units; the opus orchestrator outweighs a sonnet agent of the same size', () => {
  const { dir } = session([['s', [turn('s1', 5000)]]])
  const by = Object.fromEntries(ledger(dir).map((r) => [r.agent === 'orchestrator' ? 'o' : 's', r.units]))
  assert.ok(by.o > by.s && by.s > 0)
})

test('a wave totals the agents whose first turn falls inside it, and a wave over budget warns', () => {
  const { dir } = session([
    ['a', [turn('a1', 100000, undefined, '2026-10-10T10:00:00Z')]],
    ['b', [turn('b1', 100000, undefined, '2026-10-12T10:00:00Z')]],
  ])
  const rows = ledger(dir)
  const totals = waveTotals(rows, { w1: { from: '2026-10-10T00:00:00Z', to: '2026-10-11T00:00:00Z', budgetUnits: 1 }, w2: { from: '2026-10-11T00:00:00Z' } })
  assert.deepEqual(totals.map((t) => [t.name, t.agents]), [['w1', 1], ['w2', 2]])  // w2 is open-ended and holds agent b and the orchestrator (turn on 2026-10-30)
  assert.match(warnings(rows, totals, 200000)[0], /wave w1 used \d+ units against a budget of 1/)
})

test('an agent past the context ceiling warns; the orchestrator does not', () => {
  const { dir } = session([['big', [turn('b1', 250000)], { description: 'Big one' }]])
  const w = warnings(ledger(dir), [], 200000)
  assert.equal(w.length, 1)
  assert.match(w[0], /Big one .* 250k context/)
})

test('--wave slices by the wave file, --strict turns a warning into exit 1, a missing wave or session is exit 2', () => {
  const { dir, project } = session([['a', [turn('a1', 250000, undefined, '2026-10-10T10:00:00Z')]]])
  const waves = join(project, 'waves.json')
  writeFileSync(waves, JSON.stringify({ w1: { from: '2026-10-10T00:00:00Z', to: '2026-10-11T00:00:00Z' } }))
  assert.equal(quiet(() => ledgerMain([dir, '--waves', waves, '--wave', 'w1'])), 0)
  assert.equal(quiet(() => ledgerMain([dir, '--waves', waves, '--wave', 'w1', '--strict'])), 1)
  assert.equal(quiet(() => ledgerMain([dir, '--waves', waves, '--wave', 'nope'])), 2)
  assert.equal(quiet(() => ledgerMain([join(project, 'absent')])), 2)
})

test('--agent finds exactly one agent by id or name, and refuses an ambiguous or unknown one', () => {
  const { dir } = session([['abc123', [turn('a1', 1000)], { description: 'Build step 4' }], ['abd456', [turn('b1', 1000)], { description: 'Build step 5' }]])
  const rows = ledger(dir)
  assert.match(agentLine(rows, 'abc'), /^Build step 4 \(abc123\): sonnet-5-5, 1 turns, peak context 1k/)
  assert.match(agentLine(rows, 'step 5'), /abd456/)
  assert.equal(agentLine(rows, 'ab'), null)
  assert.equal(agentLine(rows, 'zzz'), null)
})

test('--project totals every session in a folder, with or without agents, inside the date range', () => {
  const project = mkdtempSync(join(tmpdir(), 'proj-'))
  writeFileSync(join(project, 's1.jsonl'), turn('m', 1000, 'claude-opus-5-5', '2026-10-10T10:00:00Z') + '\n')
  mkdirSync(join(project, 's2', 'subagents'), { recursive: true })
  writeFileSync(join(project, 's2.jsonl'), turn('m', 1000, 'claude-opus-5-5', '2026-10-11T10:00:00Z') + '\n')
  writeFileSync(join(project, 's2', 'subagents', 'agent-x.jsonl'), turn('m', 1000, undefined, '2026-10-11T11:00:00Z') + '\n')
  assert.equal(projectLedger(project).length, 3)
  assert.equal(projectLedger(project, '2026-10-11T00:00:00Z', '2026-10-12T00:00:00Z').length, 2)
})

test('edge inputs: an empty transcript, an agent with no meta, a truncated last line, a missing path', () => {
  const { dir } = session([['empty', ['']], ['nometa', [turn('n1', 1000), '{"type":"assistant","message":{"usa']]])
  const rows = ledger(dir)
  assert.deepEqual(rows.map((r) => r.id).sort(), ['nometa', 'sess'])
  assert.equal(rows.find((r) => r.id === 'nometa').agent, '(no description)')
  assert.equal(summarize(join(dir, 'subagents', 'nope.jsonl')), null)
  assert.equal(isFinished(join(dir, 'subagents', 'nope.jsonl')), false)
})

test('selfSession is the newest transcript in the cwd project folder, and null with none', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  assert.equal(selfSession('C:\\dev\\x', home), null)
  const folder = join(home, '.claude', 'projects', 'C--dev-x')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'old.jsonl'), '')
  const before = process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIR
  try { assert.equal(selfSession('C:\\dev\\x', home), join(folder, 'old')) } finally { if (before) process.env.CLAUDE_CONFIG_DIR = before }
})

test('an agent that handed back is finished; one messaged since, or still working, is not', () => {
  const { dir } = session([
    ['done', [turn('d1', 1000), handback('d2'), toolResult]],
    ['again', [turn('d1', 1000), handback('d2'), toolResult, resumed]],
    ['busy', [turn('d1', 1000)]],
    ['ended', [ended]],
  ])
  const f = (id) => isFinished(join(dir, 'subagents', `agent-${id}.jsonl`))
  assert.deepEqual(['done', 'again', 'busy', 'ended'].map(f), [true, false, false, true])
})

test('the hook refuses a message to a finished agent, lets RESUME-APPROVED through, and lets a running agent be corrected', () => {
  const { transcript } = session([['done', [turn('d1', 1000), handback('d2'), toolResult], { name: 'builder-2', finished: true }], ['busy', [turn('b1', 1000)]]])
  const send = (to, message) => verdict({ tool_name: 'SendMessage', transcript_path: transcript, tool_input: { to, message } }, 200000)
  const refused = send('builder-2', 'please also fix X')
  assert.equal(refused.block, true)
  assert.match(refused.reason, /already handed back/)
  assert.equal(send('builder-2', 'RESUME-APPROVED: one-line typo').block, false)
  assert.equal(send('busy', 'stop and push').block, false)
})

test('run as a hook, the script exits 2 with the reason on stderr to block, and 0 to allow or on bad input', () => {
  const { transcript } = session([['big', [turn('b1', 250000)], { finished: true }]])
  const hook = fileURLToPath(new URL('../scripts/context-ceiling.mjs', import.meta.url))
  const run = (input) => spawnSync(process.execPath, [hook], { input, encoding: 'utf8' })
  const blocked = run(JSON.stringify({ tool_name: 'SendMessage', transcript_path: transcript, tool_input: { to: 'big', message: 'x' } }))
  assert.equal(blocked.status, 2)
  assert.match(blocked.stderr, /250k context/)
  assert.equal(run(JSON.stringify({ tool_name: 'SendMessage', transcript_path: transcript, tool_input: { to: 'nobody', message: 'x' } })).status, 0)
  assert.equal(run('').status, 0)
  assert.equal(run('not json').status, 0)
})

test('the model hook refuses an Agent call naming no model, and passes a named one, a fork, a baton agent and the off switch', () => {
  const v = (tool_input, env = {}) => modelVerdict({ tool_name: 'Agent', tool_input }, env, true)
  assert.equal(v({ prompt: 'x' }).block, true)
  assert.match(v({ prompt: 'x' }).reason, /critical-read=opus.*mechanical=haiku/)
  assert.equal(v({ prompt: 'x', model: 'sonnet' }).block, false)
  assert.equal(v({ subagent_type: 'fork' }).block, false)
  assert.equal(v({ subagent_type: 'baton:quality:pr-review-followup-agent' }).block, false)
  assert.equal(v({ prompt: 'x' }, { BATON_REQUIRE_MODEL: '0' }).block, false)
  assert.equal(modelVerdict({ tool_name: 'Bash', tool_input: {} }, {}, true).block, false)
})

test('run as a hook, the model script exits 2 for an unnamed model and 0 for a named one', () => {
  const hook = fileURLToPath(new URL('../scripts/require-model.mjs', import.meta.url))
  const run = (tool_input) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'Agent', tool_input }), encoding: 'utf8', env: { ...process.env, BATON_REQUIRE_MODEL: '1', BATON_EPIC: '1' } })
  assert.equal(run({ prompt: 'x' }).status, 2)
  assert.match(run({ prompt: 'x' }).stderr, /no model named/)
  assert.equal(run({ prompt: 'x', model: 'haiku' }).status, 0)
})
