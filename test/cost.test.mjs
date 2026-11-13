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
import { ledger, projectLedger, allLedger, waveTotals, warnings, agentLine, main as ledgerMain, selfSession, selfLine, parseHandoffs, handoffCheck, rolePercentiles } from '../scripts/ledger.mjs'
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

const withEnv = (vars, fn) => {
  const keep = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  try { return fn() } finally { for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v }
}

test('selfSession finds the session id in another project folder than the working directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const here = join(home, '.claude', 'projects', 'C--dev-x')
  const there = join(home, '.claude', 'projects', 'C--dev-x-repo')
  mkdirSync(here, { recursive: true })
  mkdirSync(there, { recursive: true })
  writeFileSync(join(here, 'newest.jsonl'), '')
  writeFileSync(join(there, 'mine.jsonl'), '')
  withEnv({ CLAUDE_CONFIG_DIR: undefined, CLAUDE_CODE_SESSION_ID: 'mine' }, () => {
    assert.equal(selfSession('C:\\dev\\x', home), join(there, 'mine'))
  })
})

test('selfLine reads the last context, not the peak, and hands off when the last wave would have saved enough', () => {
  const project = mkdtempSync(join(tmpdir(), 'self-'))
  const dir = join(project, 'sess')
  const at = (m) => `2026-10-30T10:${m}:00Z`
  writeFileSync(`${dir}.jsonl`, [
    turn('p', 500_000, 'claude-opus-5-5', '2026-10-30T09:00:00Z'),
    turn('a', 300_000, 'claude-opus-5-5', at('10')),
    turn('b', 300_000, 'claude-opus-5-5', at('20')),
    turn('c', 300_000, 'claude-opus-5-5', at('30')),
  ].join('\n') + '\n')
  const waves = { w0: { from: '2026-10-29T00:00:00Z', to: '2026-10-30T09:30:00Z' }, w1: { from: at('00'), to: '2026-10-30T11:00:00Z' } }
  // (300k - 60k) x 3 turns of w1 x cache read 0.1 x opus 2 = 144k units
  const R = (minimumUnitsSaved) => ({ ...roles, handoff: { freshSessionTokens: 60_000, minimumUnitsSaved } })
  const yes = selfLine(dir, waves, R(144_000))
  assert.match(yes.line, /last context 300k/)
  assert.match(yes.line, /peak 500k/)
  assert.match(yes.line, /Wave w1: 3 turns/)
  assert.match(yes.line, /save 144k units/)
  assert.equal(yes.handOff, true)
  assert.equal(selfLine(dir, waves, R(144_001)).handOff, false)
  const none = selfLine(dir, {}, R(1))
  assert.equal(none.handOff, null)
  assert.match(none.line, /--waves/)
  assert.equal(selfLine(join(project, 'absent'), waves, R(1)), null)
  const opened = { ...waves, w2: { from: '2026-10-30T11:00:00Z' } }
  assert.match(selfLine(dir, opened, R(144_000)).line, /Wave w1: 3 turns/, 'a wave opened before --self ran is not the estimate')
  const past = selfLine(dir, waves, { ...R(10 ** 9), ceilingTokens: 150_000 })
  assert.equal(past.handOff, true)
  assert.match(past.line, /past twice the 150k ceiling/)
})

test('allLedger reads every project folder, and with clip counts only the turns inside the window', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  for (const [p, ts] of [['C--a', '2026-10-30T10:00:00Z'], ['C--b', '2026-10-30T12:00:00Z']]) {
    const folder = join(home, '.claude', 'projects', p)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 's.jsonl'), [turn(`${p}1`, 1000, 'claude-sonnet-5-5', ts), turn(`${p}2`, 1000, 'claude-sonnet-5-5', '2026-10-31T10:00:00Z')].join('\n') + '\n')
  }
  withEnv({ CLAUDE_CONFIG_DIR: undefined }, () => {
    const rows = allLedger('2026-10-30T00:00:00Z', '2026-10-31T00:00:00Z', roles, true, home)
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.turns), [1, 1])
    assert.deepEqual(allLedger('2026-10-30T00:00:00Z', '2026-10-31T00:00:00Z', roles, false, home).map((r) => r.turns), [2, 2])
  })
})

test('a role can carry a unit target per model, and the ledger warns against the target of the model that ran', () => {
  const R = { ...roles, roles: { builder: { unitTarget: 100_000, unitTargetByModel: { opus: 300_000 } } } }
  const row = (model, units) => ({ agent: `builder: ${model}`, id: model + units, role: 'builder', model, units, peakContext: 0 })
  const warned = (r) => warnings([r], [], 10 ** 9, R).filter((w) => /unit target/.test(w))
  assert.equal(warned(row('sonnet-5-5', 200_000)).length, 1)
  assert.equal(warned(row('opus-5-5', 200_000)).length, 0)
  assert.match(warned(row('opus-5-5', 400_000))[0], /past the 300k unit target of its role builder on opus/)
  const real = loadRoles().roles.builder
  assert.ok(real.unitTargetByModel.opus > 0 && real.unitTarget > 0)
})

test('selfLine prints a decision line the retro can read back, and parseHandoffs reads it', () => {
  const project = mkdtempSync(join(tmpdir(), 'self-'))
  const dir = join(project, 'sess')
  const at = (m) => `2026-10-30T10:${m}:00Z`
  writeFileSync(`${dir}.jsonl`, [turn('a', 300_000, 'claude-opus-5-5', at('10')), turn('b', 300_000, 'claude-opus-5-5', at('20')), turn('c', 300_000, 'claude-opus-5-5', at('30'))].join('\n') + '\n')
  const waves = { w1: { from: at('00'), to: '2026-10-30T11:00:00Z' } }
  const R = (minimumUnitsSaved) => ({ ...roles, handoff: { freshSessionTokens: 60_000, minimumUnitsSaved } })
  const log = selfLine(dir, waves, R(144_000)).log
  assert.match(log, /^handoff-decision /)
  assert.equal(selfLine(dir, {}, R(1)).log, null)
  const no = selfLine(dir, waves, R(144_001)).log
  const text = `# run\n\n- ${log}\nnoise\n- ${no}\n`
  const [yes, nope] = parseHandoffs(text)
  assert.deepEqual([yes.session, yes.wave, yes.lastContext, yes.turns, yes.predictedUnits, yes.handedOff], ['sess', 'w1', 300_000, 3, 144_000, true])
  assert.equal(nope.handedOff, false)
  assert.equal(parseHandoffs('nothing here').length, 0)
})

test('handoffCheck sets a decision against the next session: its mean context over the same number of turns', () => {
  const project = mkdtempSync(join(tmpdir(), 'next-'))
  const dir = join(project, 'next')
  writeFileSync(`${dir}.jsonl`, [turn('a', 50_000, 'claude-opus-5-5'), turn('b', 70_000, 'claude-opus-5-5'), turn('c', 900_000, 'claude-opus-5-5')].join('\n') + '\n')
  const d = { session: 'old', wave: 'w1', lastContext: 300_000, turns: 2, predictedUnits: 0, handedOff: true }
  const R = { ...roles, handoff: { freshSessionTokens: 60_000, minimumUnitsSaved: 1 } }
  const c = handoffCheck(d, dir, R)
  assert.equal(c.nextTurns, 2)
  assert.equal(c.meanContext, 60_000)
  // what the old session would have re-read beyond the new one's mean, over the same turns: (300k - 60k) x 2, as cache reads
  assert.equal(c.actualUnits, units({ cacheRead: 240_000 * 2 }, 'opus-5-5', R))
  assert.equal(handoffCheck(d, join(project, 'absent'), R), null)
})

test('rolePercentiles gives the count, median and 90th percentile of each role and model, nearest rank', () => {
  const rows = [...Array(10).keys()].map((i) => ({ role: 'builder', model: 'opus-5-5', units: (i + 1) * 100 }))
  rows.push({ role: 'builder', model: 'sonnet-5-5', units: 50 }, { role: null, model: 'sonnet-5-5', units: 9 })
  const p = rolePercentiles(rows, roles)
  assert.deepEqual(p['builder opus'], { n: 10, median: 500, p90: 900, max: 1000 })
  assert.deepEqual(p['builder sonnet'], { n: 1, median: 50, p90: 50, max: 50 })
  assert.equal(Object.keys(p).length, 2)
})

test('summarize stops after maxTurns turns', () => {
  const project = mkdtempSync(join(tmpdir(), 'max-'))
  const path = join(project, 's.jsonl')
  writeFileSync(path, [turn('a', 10), turn('b', 20), turn('c', 30)].join('\n') + '\n')
  const s = summarize(path, { maxTurns: 2 })
  assert.equal(s.turns, 2)
  assert.equal(s.lastContext, 20)
})
