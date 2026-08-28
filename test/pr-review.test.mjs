// Tests for pr-review.mjs.
//
// No module mocking and no PATH stubs. The only thing substituted is `run`,
// the wrapper this repo owns; `spawnSync` itself is never mocked. Every test
// below asserts on the argv that was built, because that is where every real
// bug in this script has lived.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeRun } from '../scripts/lib/exec.mjs'

// Never touch the real run log.
process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-test-'))

const { main } = await import('../scripts/pr-review.mjs')

const ENVELOPE = (over = {}) => JSON.stringify({
  is_error: false, subtype: 'success', permission_denials: [],
  result: 'Reviewed. No findings.', total_cost_usd: 0.1, ...over,
})

// A healthy repo: authenticated, PR #9 open, no existing threads.
const healthy = (envelope = ENVELOPE(), threads = '') => ([
  { cmd: 'gh', match: a => a[0] === 'auth', result: { out: 'ok' } },
  { cmd: 'gh', match: a => a[0] === 'repo', result: { out: 'jayostis/sdk-typescript' } },
  { cmd: 'gh', match: a => a[0] === 'pr', result: { out: 'befc2e6\thttps://x/9\tOPEN\tA title' } },
  { cmd: 'gh', match: a => a[0] === 'api', result: { out: threads } },
  { cmd: 'claude', result: { out: envelope, raw: envelope } },
])

const silent = { json: true }
const quiet = fn => { const w = console.log; console.log = () => {}; try { return fn() } finally { console.log = w } }

test('parseArgs rejects a non-numeric PR', () => {
  const run = fakeRun([])
  assert.equal(quiet(() => main(['--pr', 'abc', '--level', 'medium'], { run })), 2)
})

test('parseArgs rejects an unknown effort level', () => {
  const run = fakeRun([])
  assert.equal(quiet(() => main(['--pr', '9', '--level', 'turbo'], { run })), 2)
})

test('parseArgs rejects an unknown flag rather than ignoring it', () => {
  const run = fakeRun([])
  assert.equal(quiet(() => main(['--pr', '9', '--level', 'low', '--yolo'], { run })), 2)
})

// The bug that took three rounds to find: --effort is not an argument
// /code-review has, and a level written after the target is swallowed into it.
test('the effort level is positional and comes BEFORE the PR number', () => {
  const run = fakeRun(healthy())
  quiet(() => main(['--pr', '9', '--level', 'medium', '--json'], { run }))
  const claude = run.calls.find(c => c.cmd === 'claude')
  assert.ok(claude, 'claude was never spawned')
  const prompt = claude.args[claude.args.indexOf('-p') + 1]
  assert.equal(prompt, '/code-review medium 9 --comment')
  assert.ok(!claude.args.join(' ').includes('--effort'), '--effort is not an argument /code-review takes')
})

test('the headless invocation declares its tool surface and asks for JSON', () => {
  const run = fakeRun(healthy())
  quiet(() => main(['--pr', '9', '--level', 'low', '--json'], { run }))
  const args = run.calls.find(c => c.cmd === 'claude').args
  assert.ok(args.includes('--output-format') && args.includes('json'))
  assert.ok(args.includes('--permission-mode') && args.includes('dontAsk'))
  // Bare tool names: a prefix pattern cannot match composed shell, and no
  // Bash(...) rule can reach PowerShell at all.
  for (const t of ['Bash', 'PowerShell', 'Read', 'Grep', 'Glob']) assert.ok(args.includes(t), `missing grant ${t}`)
  // This verb changes no files, and deny beats allow.
  for (const t of ['Write', 'Edit', 'NotebookEdit']) assert.ok(args.includes(t), `missing deny ${t}`)
})

// The false-clean: preflight validated one repo while the reviewer resolved
// the PR number against a different working directory.
test('a --repo that disagrees with the checkout is a preflight failure, not a review', () => {
  const run = fakeRun([
    { cmd: 'gh', match: a => a[0] === 'auth', result: { out: 'ok' } },
    { cmd: 'gh', match: a => a[0] === 'repo', result: { out: 'jayostis/baton' } },
  ])
  assert.equal(quiet(() => main(['--pr', '9', '--level', 'low', '--repo', 'jayostis/other', '--json'], { run })), 2)
  assert.ok(!run.calls.some(c => c.cmd === 'claude'), 'must not spawn a reviewer it cannot target')
})

test('a non-empty denial ledger blocks even though the subprocess reported success', () => {
  const env = ENVELOPE({
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'gh api repos/x/y/pulls/9/comments -f body=the finding' } }],
  })
  const run = fakeRun(healthy(env))
  assert.equal(quiet(() => main(['--pr', '9', '--level', 'low', '--json'], { run })), 3)
})

test('a denied post is recovered from the ledger rather than lost', () => {
  const env = ENVELOPE({
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'gh api repos/x/y/pulls/9/comments -f body=RECOVER_ME' } }],
  })
  const run = fakeRun(healthy(env))
  let printed = ''
  const w = console.log; console.log = s => { printed += s }
  try { main(['--pr', '9', '--level', 'low', '--json'], { run }) } finally { console.log = w }
  assert.match(printed, /RECOVER_ME/)
})

// The regression that produced a false CLEAN: the reviewer wrote "Findings (7):"
// and the claim check only looked for "7 findings".
for (const [label, text] of [['N findings', 'I found 4 findings today'], ['Findings (N)', 'Findings (4):\n- a\n- b']]) {
  test(`a findings claim written as "${label}" with no threads is UNPROVEN, not clean`, () => {
    const run = fakeRun(healthy(ENVELOPE({ result: text })))
    assert.equal(quiet(() => main(['--pr', '9', '--level', 'low', '--json'], { run })), 4)
  })
}

test('a reviewer reporting a different level than was asked for is UNPROVEN', () => {
  const run = fakeRun(healthy(ENVELOPE({ result: 'Reviewed at effort level `low` (reused from your last run). No findings.' })))
  assert.equal(quiet(() => main(['--pr', '9', '--level', 'medium', '--json'], { run })), 4)
})

test('an unparseable envelope is UNPROVEN rather than a crash', () => {
  const run = fakeRun(healthy('not json at all'))
  assert.equal(quiet(() => main(['--pr', '9', '--level', 'low', '--json'], { run })), 4)
})

// --dry-run and --no-post must never be readable as a completed review.
test('--dry-run exits INSPECTED and spawns nothing', () => {
  const run = fakeRun(healthy())
  assert.equal(quiet(() => main(['--pr', '9', '--level', 'low', '--dry-run', '--json'], { run })), 5)
  assert.ok(!run.calls.some(c => c.cmd === 'claude'))
})

test('--no-post exits INSPECTED and omits --comment', () => {
  const run = fakeRun(healthy(ENVELOPE({ result: 'Findings (2):' })))
  assert.equal(quiet(() => main(['--pr', '9', '--level', 'low', '--no-post', '--json'], { run })), 5)
  const prompt = run.calls.find(c => c.cmd === 'claude').args[1]
  assert.equal(prompt, '/code-review low 9')
})

test('a clean run is CLEAN', () => {
  const run = fakeRun(healthy())
  assert.equal(quiet(() => main(['--pr', '9', '--level', 'low', '--json'], { run })), 0)
})

test('threads appearing after the run is FINDINGS', () => {
  const script = healthy()
  let call = 0
  script[3] = { cmd: 'gh', match: a => a[0] === 'api', result: () => ({ out: call++ === 0 ? '' : '111\n222' }) }
  const run = fakeRun(script)
  assert.equal(quiet(() => main(['--pr', '9', '--level', 'low', '--json'], { run })), 1)
})
