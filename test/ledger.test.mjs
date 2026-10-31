// Tests for the ledger and the context ceiling. Transcripts are written to a temporary session folder in the shape
// Claude Code writes them: <project>/<session>.jsonl beside <project>/<session>/subagents/agent-<id>.jsonl.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarize } from '../scripts/lib/transcript.mjs'
import { ledger } from '../scripts/ledger.mjs'
import { verdict } from '../scripts/context-ceiling.mjs'

const turn = (id, context, model = 'claude-sonnet-5-5', ts = '2026-10-30T10:00:00Z') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage: { input_tokens: 1, cache_read_input_tokens: context - 1, cache_creation_input_tokens: 0, output_tokens: 10 } } })

function session(agents) {
  const project = mkdtempSync(join(tmpdir(), 'ledger-'))
  const dir = join(project, 'sess')
  mkdirSync(join(dir, 'subagents'), { recursive: true })
  writeFileSync(join(project, 'sess.jsonl'), turn('m1', 5000, 'claude-opus-5-5') + '\n')
  for (const [id, lines, meta] of agents) {
    writeFileSync(join(dir, 'subagents', `agent-${id}.jsonl`), lines.join('\n') + '\n')
    if (meta) writeFileSync(join(dir, 'subagents', `agent-${id}.meta.json`), JSON.stringify(meta))
  }
  return { project, dir, transcript: join(project, 'sess.jsonl') }
}

test('a response streamed in several records is counted once', () => {
  const { dir } = session([['a1', [turn('x', 1000), turn('x', 1000), turn('y', 3000)]]])
  const s = summarize(join(dir, 'subagents', 'agent-a1.jsonl'))
  assert.equal(s.turns, 2)
  assert.equal(s.cacheRead, 999 + 2999)
  assert.equal(s.lastContext, 3000)
})

test('the ledger lists the orchestrator and each agent, costliest first, named from its meta', () => {
  const { dir } = session([
    ['small', [turn('s1', 1000)], { description: 'Small one' }],
    ['big', [turn('b1', 100000), turn('b2', 200000)], { description: 'Big one' }],
  ])
  const rows = ledger(dir)
  assert.deepEqual(rows.map((r) => r.agent), ['Big one', 'orchestrator', 'Small one'])
  assert.equal(rows[0].peakContext, 200000)
})

test('--since drops agents that finished before it', () => {
  const { dir } = session([['old', [turn('o1', 1000, undefined, '2026-10-01T00:00:00Z')]]])
  assert.deepEqual(ledger(dir, '2026-10-20T00:00:00Z').map((r) => r.agent), ['orchestrator'])
})

test('the ceiling blocks a message to an agent past it, by id or by name', () => {
  const { transcript } = session([['big', [turn('b1', 250000)], { name: 'builder-1' }]])
  for (const to of ['big', 'builder-1']) {
    const v = verdict({ tool_name: 'SendMessage', transcript_path: transcript, tool_input: { to } }, 200000)
    assert.equal(v.block, true)
    assert.match(v.reason, /250k context/)
  }
})

test('the ceiling lets through an agent under it, and anything it cannot resolve', () => {
  const { transcript } = session([['small', [turn('s1', 150000)]]])
  for (const to of ['small', 'a-peer-session', undefined]) {
    assert.equal(verdict({ tool_name: 'SendMessage', transcript_path: transcript, tool_input: { to } }, 200000).block, false)
  }
  assert.equal(verdict({ tool_name: 'Agent', transcript_path: transcript, tool_input: {} }, 200000).block, false)
})
