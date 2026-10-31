// Fixes from the review of PR 30. Hooks are run as the harness runs them: documented stdin, exit code, stderr.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isFinished, summarize } from '../scripts/lib/transcript.mjs'
import { ledger, warnings, selfSession, inWave } from '../scripts/ledger.mjs'
import { units, loadRoles } from '../scripts/lib/roles.mjs'
import { epicRows } from '../scripts/history.mjs'

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url))
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (f) => readFileSync(join(root, f), 'utf8')
const turn = (id, ctx, ts = '2026-10-30T10:00:00Z', model = 'claude-sonnet-5-5') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage: { input_tokens: 1, cache_read_input_tokens: ctx - 1, output_tokens: 10 } } })
const endTurn = JSON.stringify({ type: 'assistant', message: { id: 'e', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [], usage: { input_tokens: 1 } } })
const handback = JSON.stringify({ type: 'assistant', message: { id: 'h', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'SubagentHandback', input: {} }], usage: { input_tokens: 1, cache_read_input_tokens: 299999 } } })

function session(agents) {
  const project = mkdtempSync(join(tmpdir(), 'r30-'))
  const dir = join(project, 'sess')
  mkdirSync(join(dir, 'subagents'), { recursive: true })
  writeFileSync(join(project, 'sess.jsonl'), turn('m1', 5000, undefined, 'claude-opus-5-5') + '\n')
  for (const [id, lines, meta] of agents) {
    writeFileSync(join(dir, 'subagents', `agent-${id}.jsonl`), lines.join('\n') + '\n')
    if (meta) writeFileSync(join(dir, 'subagents', `agent-${id}.meta.json`), JSON.stringify(meta))
  }
  return { project, dir, transcript: join(project, 'sess.jsonl') }
}

const hook = (name, input, env = {}) => {
  const r = spawnSync(process.execPath, [script(name)], {
    input: JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_use_id: 't', ...input }),
    encoding: 'utf8', env: { ...process.env, BATON_REQUIRE_MODEL: '', BATON_EPIC: '', ...env },
  })
  return { status: r.status, stderr: r.stderr }
}

const epicMode = (verb, baton) =>
  spawnSync(process.execPath, [script('epic-mode.mjs'), verb], { encoding: 'utf8', env: { ...process.env, BATON_HOME: baton, CLAUDE_CODE_SESSION_ID: 's1' } })

// B1
test('B1: outside an epic the model hook blocks nothing, from the session or from inside a subagent', () => {
  const env = { BATON_HOME: mkdtempSync(join(tmpdir(), 'r30b-')) }
  for (const tool_input of [{ subagent_type: 'Explore', prompt: 'x' }, { subagent_type: 'Plan', prompt: 'x' }, { subagent_type: 'claude-code-guide', prompt: 'x' }, { subagent_type: 'baton:deliver:deliver-tests-agent', prompt: 'x' }, { prompt: 'x' }]) {
    assert.equal(hook('require-model.mjs', { tool_name: 'Agent', tool_input }, env).status, 0, JSON.stringify(tool_input))
    assert.equal(hook('require-model.mjs', { tool_name: 'Agent', tool_input, agent_id: 'a1', agent_type: 'general-purpose' }, env).status, 0)
  }
})

test('B1: inside an epic (marker for the session, or BATON_EPIC=1) only an unnamed general-purpose dispatch is blocked', () => {
  const baton = mkdtempSync(join(tmpdir(), 'r30b-'))
  const on = epicMode('on', baton)
  assert.equal(on.status, 0, on.stderr)
  const env = { BATON_HOME: baton }
  const run = (tool_input, e = env) => hook('require-model.mjs', { tool_name: 'Agent', tool_input }, e)
  assert.equal(run({ prompt: 'x' }).status, 2)
  assert.match(run({ prompt: 'x' }).stderr, /no model named/)
  assert.equal(run({ subagent_type: 'general-purpose', prompt: 'x' }).status, 2)
  assert.equal(run({ prompt: 'x', model: 'sonnet' }).status, 0)
  for (const t of ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'fork', 'baton:deliver:deliver-tests-agent']) assert.equal(run({ subagent_type: t, prompt: 'x' }).status, 0, t)
  assert.equal(run({ prompt: 'x' }, { BATON_HOME: baton, BATON_REQUIRE_MODEL: '0' }).status, 0)
  assert.equal(hook('require-model.mjs', { session_id: 'other', tool_name: 'Agent', tool_input: { prompt: 'x' } }, env).status, 0)
  assert.equal(epicMode('off', baton).status, 0)
  assert.equal(run({ prompt: 'x' }).status, 0)
  assert.equal(run({ prompt: 'x' }, { BATON_HOME: baton, BATON_EPIC: '1' }).status, 2)
})

// B2
test('B2: a running agent over the ceiling can be told to stop; a finished one needs RESUME-APPROVED, which passes', () => {
  const { transcript } = session([['big', [turn('b1', 300000)], { name: 'builder-1' }], ['bigdone', [turn('b1', 300000), handback], { name: 'builder-2', finished: true }]])
  const send = (to, message) => hook('context-ceiling.mjs', { tool_name: 'SendMessage', transcript_path: transcript, tool_input: { to, message } })
  assert.equal(send('builder-1', 'Stop now: push and hand back').status, 0)
  assert.equal(send('builder-2', 'one more thing').status, 2)
  assert.equal(send('builder-2', 'RESUME-APPROVED: typo in the handback').status, 0)
})

test('B2: a trailing [ref] on `to` is stripped, and a message-less call (notify_when_idle) is not checked', () => {
  const { transcript } = session([['done', [turn('d', 1000), endTurn], { name: 'builder-1', finished: true }]])
  const send = (tool_input) => hook('context-ceiling.mjs', { tool_name: 'SendMessage', transcript_path: transcript, tool_input })
  assert.equal(send({ to: 'builder-1 [ref]', message: 'again' }).status, 2)
  assert.equal(send({ to: 'builder-1', notify_when_idle: true }).status, 0)
})

// S1
test('S1: meta finished decides; a running agent whose last response ended the turn is not finished', () => {
  const { dir } = session([
    ['waiting', [turn('w1', 1000), endTurn], { name: 'a' }],
    ['done', [turn('d1', 1000)], { name: 'b', finished: true }],
    ['nometa', [turn('n1', 1000), endTurn]],
  ])
  const f = (id) => isFinished(join(dir, 'subagents', `agent-${id}.jsonl`))
  assert.deepEqual(['waiting', 'done', 'nometa'].map(f), [false, true, true])
})

// S2
test('S2: a reused name goes to the newest agent by mtime', () => {
  const { dir, transcript } = session([['a0000old', [turn('o', 1000), endTurn], { name: 'w3-fix', finished: true }], ['affffnew', [turn('n', 1000)], { name: 'w3-fix' }]])
  const past = new Date('2026-01-01T00:00:00Z')
  for (const f of ['agent-a0000old.jsonl', 'agent-a0000old.meta.json']) utimesSync(join(dir, 'subagents', f), past, past)
  const r = hook('context-ceiling.mjs', { tool_name: 'SendMessage', transcript_path: transcript, tool_input: { to: 'w3-fix', message: 'check the other file' } })
  assert.equal(r.status, 0, r.stderr)
})

// S3
test('S3: --self prefers CLAUDE_CODE_SESSION_ID, then the newest transcript', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const folder = join(home, '.claude', 'projects', 'C--dev-x')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'mine.jsonl'), '')
  writeFileSync(join(folder, 'other.jsonl'), '')
  utimesSync(join(folder, 'mine.jsonl'), new Date(1e12), new Date(1e12))
  const keep = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID }
  delete process.env.CLAUDE_CONFIG_DIR
  try {
    process.env.CLAUDE_CODE_SESSION_ID = 'mine'
    assert.equal(selfSession('C:\\dev\\x', home), join(folder, 'mine'))
    process.env.CLAUDE_CODE_SESSION_ID = 'gone'
    assert.equal(selfSession('C:\\dev\\x', home), join(folder, 'other'))
    delete process.env.CLAUDE_CODE_SESSION_ID
    assert.equal(selfSession('C:\\dev\\x', home), join(folder, 'other'))
  } finally {
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

// S4
test('S4: windows compare instants, so an offset timestamp lands where it falls', () => {
  // 2026-10-30T19:00:00-07:00 is 2026-10-31T02:00:00Z; as strings it sorts before the 23:00Z turn below
  const { dir } = session([['a', [turn('x', 1000, '2026-10-30T23:00:00Z')]]])
  assert.equal(ledger(dir, '2026-10-30T15:00:00-07:00').some((r) => r.id === 'a'), true)
  assert.equal(ledger(dir, '2026-10-30T19:00:00-07:00').some((r) => r.id === 'a'), false)
  assert.equal(summarize(join(dir, 'subagents', 'agent-a.jsonl'), { since: '2026-10-30T19:00:00-07:00' }).turns, 0)
  assert.equal(inWave({ start: '2026-10-30T23:00:00Z' }, { from: '2026-10-30T15:00:00-07:00', to: '2026-10-30T19:00:00-07:00' }), true)
})

test('S4: history keeps a session stamped inside a window given by date', () => {
  const projects = mkdtempSync(join(tmpdir(), 'hist-'))
  const proj = join(projects, 'p')
  mkdirSync(join(proj, 's', 'subagents'), { recursive: true })
  writeFileSync(join(proj, 's.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-10-30T20:00:00-07:00', message: { role: 'user', content: 'epic-9 epic-9' } }) + '\n' + turn('t', 1000, '2026-10-30T20:00:00-07:00') + '\n')
  const later = new Date('2026-11-02T00:00:00Z')
  utimesSync(join(proj, 's.jsonl'), later, later)
  // 2026-10-30T20:00:00-07:00 is 2026-10-31T03:00:00Z: inside a window of the 31st, though it sorts before it as a string
  const rows = epicRows(projects, [{ epic: 'e9', from: '2026-10-31', to: '2026-10-31', match: 'epic-9' }])
  assert.notEqual(rows[0].cost_units, null)
})

// S7
test('S7: the role is the first word of the dispatch description; an agent past its role token target warns', () => {
  const big = [turn('a', 700000), turn('b', 700000)]
  const { dir } = session([
    ['f1', [...big, ...big], { name: 'x', description: 'fix: w3 round 2' }],
    ['f2', [turn('z', 1000)], { name: 'y', description: 'fix: small' }],
    ['f3', [...big, ...big], { name: 'q', description: 'something else' }],
  ])
  const roles = loadRoles()
  const rows = ledger(dir)
  assert.equal(rows.find((r) => r.id === 'f1').role, 'fix')
  assert.equal(rows.find((r) => r.id === 'f3').role, null)
  const out = warnings(rows, [], 10 ** 9, roles).filter((w) => /token target/.test(w))
  assert.equal(out.length, 1)
  assert.match(out[0], /f1/)
  assert.match(roles.tokenTargetUnit, /tokens/)
})

// S8
test('S8: the SubagentStop hook appends the agent ledger row to the run log and never blocks', () => {
  const { dir } = session([['a1', [turn('x', 1000), turn('y', 2000)], { name: 'builder-1', description: 'builder: step 3', finished: true }]])
  const baton = mkdtempSync(join(tmpdir(), 'r30b-'))
  const stop = (input, env = {}) => spawnSync(process.execPath, [script('ledger-hook.mjs')], { input, encoding: 'utf8', env: { ...process.env, BATON_HOME: baton, ...env } })
  const r = stop(JSON.stringify({ session_id: 'sess', cwd: root, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: join(dir, 'subagents', 'agent-a1.jsonl') }))
  assert.equal(r.status, 0, r.stderr)
  const file = join(baton, 'runs', 'baton.jsonl')
  assert.ok(existsSync(file), 'no run log written')
  const rec = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1))
  assert.equal(rec.tool, 'ledger')
  assert.equal(rec.id, 'a1')
  assert.equal(rec.role, 'builder')
  assert.equal(rec.turns, 2)
  assert.equal(stop('not json').status, 0)
  assert.equal(stop(JSON.stringify({ agent_transcript_path: '/nope' })).status, 0)
  assert.match(JSON.stringify(JSON.parse(read('hooks/hooks.json')).hooks.SubagentStop), /ledger-hook\.mjs/)
})

// nits
test('nit: fable has a weight', () => {
  const roles = loadRoles()
  assert.ok(roles.weights.models.fable > 0)
  assert.equal(units({ input: 1000 }, 'claude-fable-1', roles), Math.round(1000 * roles.weights.models.fable))
})

test('nit: pr-review refuses --model with no value or a flag as its value', () => {
  for (const argv of [['--model'], ['--model', '--dry-run']]) {
    const r = spawnSync(process.execPath, [script('pr-review.mjs'), '--pr', '1', '--level', 'low', ...argv], { encoding: 'utf8' })
    assert.equal(r.status, 2, argv.join(' '))
    assert.match(r.stderr, /--model/)
  }
})

test('nit: briefs run scripts by ${CLAUDE_PLUGIN_ROOT}, and no public file names a project or a person', () => {
  for (const f of ['references/handback.md', 'skills/epic/retro.md']) {
    for (const line of read(f).split('\n')) assert.ok(!/(^|[\s`])node scripts\//.test(line), `${f}: ${line}`)
  }
  for (const f of ['scripts/require-model.mjs', 'scripts/context-ceiling.mjs', 'references/roles.json']) {
    assert.doesNotMatch(read(f), /care-gaps|Jay|this user/i, f)
  }
})

test('nit: threads list logs counts, not thread bodies; comments.md shows the thread URL', () => {
  const src = read('scripts/threads.mjs')
  assert.doesNotMatch(src, /appendRun\('threads', d\.repo, \{ cmd: o\.cmd, \.\.\.d,/)
  assert.match(read('skills/pr/comments.md'), /`url`/)
  assert.match(src, /url/)
})

test('S5/S6: deliver names scoped agents; every brief states the layout the skill gives, project config included', () => {
  const d = read('skills/deliver/SKILL.md')
  for (const a of ['deliver-tests-agent', 'deliver-implement-agent', 'deliver-checklist-agent']) assert.match(d, new RegExp(`baton:deliver:${a}`))
  assert.match(read('skills/epic/SKILL.md'), /5 the absolute\s+path of the project config/)
  for (const f of ['builder', 'fix', 'reviewer', 'mechanical', 'critical-read', 'walk']) {
    const t = read(`skills/epic/${f}.md`)
    assert.match(t, /Prompt lines: 1 [^\n]*2 this file/, f)
    assert.match(t, /project config/i, f)
  }
})
