// A walk reports every item of its input as walked or not walked. dispatch.mjs refuses a walk input with no numbered list;
// walk-check.mjs compares the list with the handback; the SubagentHandback hook runs it before a walk can hand back, and
// ledger.mjs --agent prints it for a walk. Transcripts are written in the shape Claude Code writes them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { walkItems, uncovered, walkOf } from '../scripts/walk-check.mjs'
import { dispatch } from '../scripts/dispatch.mjs'
import { main as ledgerMain } from '../scripts/ledger.mjs'

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'walk-'))
const LIST = '# Walk: the epic\n\nDrive what shipped.\n\n1. Home first screen (#77)\n2. Status page (#78)\n   1. a nested detail, not an item\n3. Hub search box (#768)\n\nNotes: screenshots at 500 px.\n'
const ALL = 'Walked the preview.\n\n1. walked: the first screen reads well\n2. not walked: the page 404s on the preview\n- 3. **walked**: search finds the term\n'

test('walkItems reads the top-level numbered items; uncovered names those the handback does not report', () => {
  assert.deepEqual(walkItems(LIST), [1, 2, 3])
  assert.deepEqual(walkItems('- a\n- b\n'), [])
  assert.deepEqual(walkItems(''), [])
  assert.deepEqual(uncovered(LIST, ALL), [])
  assert.deepEqual(uncovered(LIST, '1. walked\n3. Walked: fine\n'), [2])
  assert.deepEqual(uncovered(LIST, 'Items 1, 2 and 3 were walked.\n'), [1, 2, 3], 'a sentence is not a report of each item')
  assert.deepEqual(uncovered(LIST, '1. walked\n2. looked at it\n3. not walked\n'), [2], 'an item line that says neither')
  assert.deepEqual(uncovered(LIST, '1. walked\n2. walked\n3. walked\n4. walked\n'), [], 'an extra line is not a failure')
})

test('walk-check.mjs exits 0 when every item is reported, 1 naming the missing ones, 2 for an input with no list', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'input.md'), LIST)
  writeFileSync(join(dir, 'ok.md'), ALL)
  writeFileSync(join(dir, 'half.md'), '1. walked\n')
  writeFileSync(join(dir, 'bullets.md'), '- a\n- b\n')
  const run = (...args) => spawnSync(process.execPath, [script('walk-check.mjs'), ...args], { encoding: 'utf8' })
  assert.equal(run(join(dir, 'input.md'), join(dir, 'ok.md')).status, 0)
  const half = run(join(dir, 'input.md'), join(dir, 'half.md'))
  assert.equal(half.status, 1)
  assert.match(half.stdout, /items 2, 3 of 3 are not reported as walked or not walked/)
  assert.equal(run(join(dir, 'bullets.md'), join(dir, 'ok.md')).status, 2)
  assert.equal(run().status, 2)
  const stdin = spawnSync(process.execPath, [script('walk-check.mjs'), join(dir, 'input.md'), '-'], { input: ALL, encoding: 'utf8' })
  assert.equal(stdin.status, 0, 'the handback on stdin')
})

test('dispatch.mjs refuses a walk without an input file that holds a numbered list', () => {
  const dir = tmp()
  const config = join(dir, 'project.md')
  writeFileSync(config, '# c\n')
  const env = { BATON_PROJECT_CONFIG: config }
  writeFileSync(join(dir, 'list.md'), LIST)
  writeFileSync(join(dir, 'bullets.md'), '- Home (#77)\n- Status (#78)\n')
  assert.equal(dispatch({ role: 'walk', step: 'w7 #64', subject: 'what shipped', input: join(dir, 'list.md') }, { env }).lines.length, 5)
  assert.throws(() => dispatch({ role: 'walk', step: 'w7 #64', subject: 'x', input: join(dir, 'bullets.md') }, { env }), /numbered list/)
  assert.throws(() => dispatch({ role: 'walk', step: 'w7 #64', subject: 'x' }, { env }), /numbered list/)
  assert.throws(() => dispatch({ role: 'walk', step: 'w7 #64', subject: 'x', input: 'https://github.com/o/r/issues/64' }, { env }), /numbered list/)
})

// A session folder with one walk agent whose prompt's line 3 is the input file, ending in a SubagentHandback call.
function session({ description = 'walk: w7 #64 what shipped', handback = ALL, viaTool = true } = {}) {
  const project = tmp()
  const input = join(project, 'walk-input.md').replace(/\\/g, '/')
  writeFileSync(input, LIST)
  const subs = join(project, 'sess', 'subagents')
  mkdirSync(subs, { recursive: true })
  writeFileSync(join(project, 'sess.jsonl'), JSON.stringify({ type: 'assistant', timestamp: '2026-11-14T10:00:00Z', message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n')
  const prompt = `1. what shipped\n2. /plugin/skills/epic/walk.md\n3. ${input}\n4. /plugin\n5. /project.md\n\nHeld by the orchestrator: a note.`
  const lines = [
    { type: 'user', agentId: 'w1', message: { role: 'user', content: prompt } },
    { type: 'assistant', timestamp: '2026-11-14T10:05:00Z', message: { id: 'a1', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, cache_read_input_tokens: 1000, output_tokens: 10 }, content: viaTool ? [{ type: 'tool_use', name: 'SubagentHandback', input: { message: handback } }] : [{ type: 'text', text: handback }] } },
  ]
  writeFileSync(join(subs, 'agent-w1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  writeFileSync(join(subs, 'agent-w1.meta.json'), JSON.stringify({ description }))
  return { project, dir: join(project, 'sess'), transcript: join(project, 'sess.jsonl'), agent: join(subs, 'agent-w1.jsonl') }
}

test('walkOf reads the input path from the prompt\'s line 3 and the handback from SubagentHandback or the last text', () => {
  const s = session()
  assert.equal(walkOf(s.agent).input.replace(/\\/g, '/'), `${s.project.replace(/\\/g, '/')}/walk-input.md`)
  assert.match(walkOf(s.agent).handback, /3\. \*\*walked\*\*/)
  assert.match(walkOf(session({ viaTool: false }).agent).handback, /1\. walked/)
})

const hook = (input, env = {}) => spawnSync(process.execPath, [script('walk-hook.mjs')], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, BATON_EPIC: '1', ...env } })

test('the SubagentHandback hook refuses a walk\'s handback that leaves an item unreported, naming it', () => {
  const s = session()
  const base = { session_id: 's1', transcript_path: s.transcript, agent_id: 'w1', hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback' }
  assert.equal(hook({ ...base, tool_input: { message: ALL } }).status, 0)
  const half = hook({ ...base, tool_input: { message: '1. walked: fine\n' } })
  assert.equal(half.status, 2)
  assert.match(half.stderr, /items 2, 3 of 3/)
  assert.match(half.stderr, /walked or not walked/)
  assert.equal(hook({ ...base, transcript_path: s.agent, agent_id: undefined, tool_input: { message: '1. walked\n' } }).status, 2, 'the agent\'s own transcript as transcript_path')
  const builder = session({ description: 'builder: w1 s01 x' })
  assert.equal(hook({ ...base, transcript_path: builder.transcript, tool_input: { message: 'done' } }).status, 0, 'not a walk')
  assert.equal(hook({ ...base, tool_input: { message: '1. walked\n' } }, { BATON_EPIC: '' }).status, 0, 'not an epic')
  assert.equal(hook({ ...base, agent_id: 'nobody', tool_input: { message: 'x' } }).status, 0, 'an agent it cannot find')
  assert.equal(spawnSync(process.execPath, [script('walk-hook.mjs')], { input: 'junk', encoding: 'utf8' }).status, 0)
})

test('ledger.mjs --agent prints the walk check under a walk\'s line, and exits 1 when an item is unreported', () => {
  const out = []
  const capture = (fn) => {
    const log = console.log, err = console.error
    console.log = (s) => out.push(String(s)); console.error = (s) => out.push(String(s))
    try { return fn() } finally { console.log = log; console.error = err }
  }
  assert.equal(capture(() => ledgerMain([session().dir, '--agent', 'w1'])), 0)
  assert.match(out.join('\n'), /walk check: all 3 items reported/)
  out.length = 0
  assert.equal(capture(() => ledgerMain([session({ handback: '2. walked\n' }).dir, '--agent', 'w1'])), 1)
  assert.match(out.join('\n'), /walk check: items 1, 3 of 3 are not reported/)
  out.length = 0
  assert.equal(capture(() => ledgerMain([session({ description: 'builder: w1 s01', handback: 'x' }).dir, '--agent', 'w1'])), 0)
  assert.doesNotMatch(out.join('\n'), /walk check/)
})
