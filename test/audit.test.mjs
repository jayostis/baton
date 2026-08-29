// Tests for audit.mjs — the drain that reads the run log nobody reads.
//
// The log is the input, so the log is the fixture: written to a temp directory
// line by line, in the shape the real records actually have. Two properties of
// the real file are load-bearing here and are reproduced deliberately —
// **one of the three identical PREFLIGHT records carries no `tool` field**
// (it predates that field), and two of them land inside the same minute. A
// fingerprint that keys on `tool` splits that group into 2 + 1 and the count
// of 3 the issue asks for never appears.
//
// No module mocking and no PATH stubs: the only thing substituted is `run`,
// the wrapper this repo owns.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeRun } from '../scripts/lib/exec.mjs'

// Never touch the real run log — not to read it, and not to have the auditor's
// own record appended to it.
process.env.BATON_HOME = mkdtempSync(join(tmpdir(), 'baton-audit-home-'))

const { main } = await import('../scripts/audit.mjs')

const THIS_REPO = 'jayostis/baton'

// ---------------------------------------------------------------- fixtures

const PREFLIGHT_REASON =
  '--repo says jayostis/sdk-typescript but C:\\Users\\Jay\\.claude\\skills\\baton is a checkout of jayostis/baton'

const preflight = (ts, tool) => ({
  schema: 1, ...(tool ? { tool } : {}), ts, repo: 'jayostis/sdk-typescript',
  outcome: 'preflight', exit: 2, reason: PREFLIGHT_REASON,
  pr: '9', dir: 'C:\\Users\\Jay\\.claude\\skills\\baton', levelAsked: 'medium', levelSeen: null,
})

// One denied, one level mismatch, one findings claim the PR does not hold,
// three identical preflight reasons, and two runs that were simply fine.
const RECORDS = [
  {
    schema: 1, tool: 'pr-review', ts: '2026-08-28T20:03:11.001Z', repo: 'jayostis/sdk-typescript',
    outcome: 'denied', exit: 3, reason: '2 tool call(s) denied; the review could not deliver',
    pr: '9', denials: 2, deniedTools: ['Bash'], levelAsked: 'medium', levelSeen: 'medium',
  },
  {
    schema: 1, tool: 'pr-review', ts: '2026-08-28T20:19:44.220Z', repo: 'jayostis/sdk-typescript',
    outcome: 'unproven', exit: 4, reason: 'asked for medium, the reviewer reports running at low',
    pr: '9', levelAsked: 'medium', levelSeen: 'low', threadsAdded: 0, claimed: null,
  },
  {
    schema: 1, tool: 'pr-review', ts: '2026-08-28T20:31:02.900Z', repo: 'jayostis/sdk-typescript',
    outcome: 'unproven', exit: 4, reason: 'the reviewer reports 4 finding(s) and the PR holds none',
    pr: '9', levelAsked: 'high', levelSeen: 'high', threadsAdded: 0, claimed: 4,
  },
  preflight('2026-08-28T21:28:54.783Z', null),          // predates the `tool` field
  preflight('2026-08-28T21:28:58.101Z', 'pr-review'),   // same minute, another session
  preflight('2026-08-28T21:42:30.897Z', 'pr-review'),
  {
    schema: 1, tool: 'pr-review', ts: '2026-08-28T22:04:00.000Z', repo: 'jayostis/sdk-typescript',
    outcome: 'clean', exit: 0, reason: 'ran, nothing denied, no findings posted',
    pr: '9', levelAsked: 'low', levelSeen: 'low', denials: 0, threadsAdded: 0,
  },
  {
    schema: 1, tool: 'threads', ts: '2026-08-28T22:06:12.931Z', repo: 'jayostis/sdk-typescript',
    outcome: 'ok', exit: 0, reason: '0 unresolved thread(s), 0 outdated', cmd: 'list', pr: '9',
  },
]

const jsonl = records => records.map(r => JSON.stringify(r)).join('\n') + '\n'

function runsDir(files) {
  const d = mkdtempSync(join(tmpdir(), 'baton-audit-runs-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text)
  return d
}

// ---------------------------------------------------------------- harness

// gh is scripted permissively for everything that is not the issue query, so a
// preflight the implementation happens to make cannot fail a test about
// something else. The issue query is the only call any assertion looks at.
const ghScript = (issuesJson = '[]') => ([
  { cmd: 'gh', match: a => a[0] === 'auth', result: { out: 'ok' } },
  { cmd: 'gh', match: a => a[0] === 'repo', result: { out: THIS_REPO } },
  { cmd: 'gh', match: a => a[0] === 'issue', result: { out: issuesJson } },
])

const capture = fn => {
  const w = console.log
  let printed = ''
  console.log = s => { printed += String(s) + '\n' }
  try { fn() } finally { console.log = w }
  return printed
}

// Returns the parsed report and the fake, so a test can assert on either.
function audit(dir, { issues = '[]', argv = [] } = {}) {
  const run = fakeRun(ghScript(issues))
  const printed = capture(() => main(['--runs', dir, '--repo', THIS_REPO, '--json', ...argv], { run }))
  return { out: JSON.parse(printed), run }
}

const issueCalls = run => run.calls.filter(c => c.cmd === 'gh' && c.args[0] === 'issue')

// ---------------------------------------------------------------- the classifier

test('the log classifies into four candidates, the repeated preflight one counted not repeated', () => {
  const dir = runsDir({ 'jayostis__sdk-typescript.jsonl': jsonl(RECORDS) })
  const { out } = audit(dir)

  assert.equal(out.candidates.length, 4, 'one denied, one level mismatch, one unposted findings claim, one repeated preflight')
  assert.deepEqual(out.candidates.map(c => c.count).sort((a, b) => a - b), [1, 1, 1, 3],
    'the three identical preflight reasons are ONE candidate with a count of 3, not three candidates')
  assert.equal(new Set(out.candidates.map(c => c.fingerprint)).size, 4,
    'four distinct facts, so four distinct fingerprints')
  for (const c of out.candidates) {
    assert.ok(typeof c.fingerprint === 'string' && c.fingerprint.length > 0,
      'a candidate with no fingerprint can never be deduped against an issue body')
  }
})

// ---------------------------------------------------------------- a torn log

test('a truncated final line and an unknown schema are skipped and counted, and the rest still classifies', () => {
  const torn = jsonl(RECORDS)
    + JSON.stringify({ schema: 9, tool: 'pr-review', ts: '2026-08-28T23:00:00.000Z', repo: 'jayostis/sdk-typescript', outcome: 'denied', reason: 'from a future writer' }) + '\n'
    + '{"schema":1,"tool":"pr-review","ts":"2026-08-28T23:01:00.000Z","repo":"jayostis/sdk-typ'
  const dir = runsDir({ 'jayostis__sdk-typescript.jsonl': torn })
  const { out } = audit(dir)

  assert.equal(out.skipped, 2, 'the torn tail and the unknown schema are both skipped, and both counted')
  assert.equal(out.candidates.length, 4, 'every parseable record still classifies')
  assert.deepEqual(out.candidates.map(c => c.count).sort((a, b) => a - b), [1, 1, 1, 3])
})

// ---------------------------------------------------------------- dedupe

test('the issue query is one gh invocation and it carries --state all', () => {
  const dir = runsDir({ 'jayostis__sdk-typescript.jsonl': jsonl(RECORDS) })
  const { run } = audit(dir)

  const calls = issueCalls(run)
  assert.equal(calls.length, 1, 'one query for the whole run, not one per candidate')
  assert.match(calls[0].args.join(' '), /--state[= ]all/,
    'an open issue is not the only duplicate: a fact already closed must not be raised again')
})

test('a candidate whose fingerprint is already in an issue body is dropped — closed issues included', () => {
  const dir = runsDir({ 'jayostis__sdk-typescript.jsonl': jsonl(RECORDS) })

  const first = audit(dir).out
  assert.ok(first.candidates.length >= 2, 'need two candidates to drop two')
  const [open, closed] = first.candidates.map(c => c.fingerprint)

  const issues = JSON.stringify([
    { number: 12, state: 'OPEN', title: 'pr-review denied', body: `Seen before.\n\nbaton-fingerprint: ${open}\n` },
    { number: 7, state: 'CLOSED', title: 'level drift', body: `Closed as working as intended. ${closed}` },
  ])
  const second = audit(dir, { issues }).out

  assert.ok(!second.candidates.some(c => c.fingerprint === open), 'already raised as an open issue')
  assert.ok(!second.candidates.some(c => c.fingerprint === closed), 'already raised, and closed — raising it again is the duplicate')
  assert.equal(second.candidates.length, first.candidates.length - 2)
})

// ---------------------------------------------------------------- redaction

test('nothing emitted carries the absolute path, the username, the observed repo, or the excerpt', () => {
  const record = {
    schema: 1, tool: 'pr-review', ts: '2026-08-28T20:03:11.001Z',
    repo: 'jayostis/private-oncology',
    outcome: 'denied', exit: 3, reason: '2 tool call(s) denied; the review could not deliver',
    pr: '4', dir: 'C:\\Users\\Jay\\dev\\onc-secret', levelAsked: 'medium', levelSeen: 'medium',
    denials: 1, deniedTools: ['Bash'],
    resultExcerpt: 'PATIENT_ROSTER_TOKEN ' + 'x'.repeat(3979),
  }
  const dir = runsDir({ 'jayostis__private-oncology.jsonl': jsonl([record]) })
  const { out } = audit(dir)

  assert.equal(out.candidates.length, 1, 'redaction over nothing proves nothing')
  const text = JSON.stringify(out)
  assert.doesNotMatch(text, /Users[\\/]+Jay/, 'the absolute path')
  assert.doesNotMatch(text, /onc-secret/, 'the leaf of the absolute path')
  assert.doesNotMatch(text, /\bJay\b/, 'the username')
  assert.doesNotMatch(text, /private-oncology/, 'the repository the fact was observed in')
  assert.doesNotMatch(text, /PATIENT_ROSTER_TOKEN/, 'the excerpt')
  assert.doesNotMatch(text, /x{200}/, 'the excerpt, truncated, is still the excerpt')
})
