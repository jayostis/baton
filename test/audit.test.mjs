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
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
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

// ---------------------------------------------------------------- review followup
//
// One test per finding raised on PR #20. Each fails against the code as
// reviewed and passes after the fix, so the fix is the thing under test rather
// than the description of it.

// Returns the printed text and the exit code, for the paths that never reach
// the JSON report — a parseArgs error is reported on the human line.
function auditRaw(argv) {
  const run = fakeRun(ghScript())
  let code
  const printed = capture(() => { code = main(argv, { run }) })
  return { printed, code }
}

test('a --no-post run is not filed as findings-unposted: nothing was posted by design', () => {
  const record = {
    schema: 1, tool: 'pr-review', ts: '2026-08-28T20:03:11.001Z', repo: 'jayostis/sdk-typescript',
    outcome: 'inspected', exit: 5, reason: 'no-post run: 3 finding(s) reported, none posted by design',
    pr: '9', levelAsked: 'medium', levelSeen: 'medium', threadsAdded: 0, claimed: 3, noPost: true,
  }
  const dir = runsDir({ 'jayostis__sdk-typescript.jsonl': jsonl([record]) })
  const { out } = audit(dir)

  assert.ok(!out.candidates.some(c => c.kind === 'findings-unposted'),
    'the record says noPost and inspected; filing it is filing the guard working as a defect')
  assert.equal(out.candidates.length, 0, 'a no-post run that reported findings is not a finding')
})

test('a genuine unposted findings claim is still reported', () => {
  const genuine = RECORDS.filter(r => r.claimed === 4)
  const dir = runsDir({ 'jayostis__sdk-typescript.jsonl': jsonl(genuine) })
  const { out } = audit(dir)

  assert.deepEqual(out.candidates.map(c => c.kind), ['findings-unposted'],
    'an unproven run that claimed findings and posted none is still the finding it was')
})

test('a Windows path containing a space is redacted whole, and the prose after it survives', () => {
  const record = {
    schema: 1, tool: 'pr-review', ts: '2026-08-28T20:03:11.001Z', repo: 'jayostis/sdk-typescript',
    outcome: 'denied', exit: 3, denials: 1, deniedTools: ['Bash'],
    reason: 'C:\\Users\\Jay\\OneDrive - Acme Corp\\clients\\bigpharma-secret is not a checkout of a GitHub repository',
  }
  const dir = runsDir({ 'jayostis__sdk-typescript.jsonl': jsonl([record]) })
  const { out } = audit(dir)
  const text = JSON.stringify(out)

  assert.doesNotMatch(text, /bigpharma-secret/, 'the private leaf, past the space')
  assert.doesNotMatch(text, /Acme/, 'the organisation name, past the space')
  assert.doesNotMatch(text, /OneDrive/, 'the segment the space sits in')
  assert.match(text, /is not a checkout of a GitHub repository/,
    'redaction must stop at the path: swallowing the sentence destroys the evidence and collapses distinct reasons')
})

test('--since accepts what Date.parse accepts and compares it chronologically, not lexically', () => {
  const dir = runsDir({ 'jayostis__sdk-typescript.jsonl': jsonl(RECORDS) })

  const before = audit(dir, { argv: ['--since', 'Aug 1 2026'] }).out
  assert.equal(before.scanned, RECORDS.length,
    'every record is newer than Aug 1 2026; a lexical compare drops them all and reports a clean sweep of nothing')

  const after = audit(dir, { argv: ['--since', 'Dec 1 2026'] }).out
  assert.equal(after.scanned, 0, 'and a window that genuinely excludes them still excludes them')
})

test('evidence reports the recorded number of denials, not the number of distinct tool names', () => {
  const record = {
    schema: 1, tool: 'pr-review', ts: '2026-08-28T20:03:11.001Z', repo: 'jayostis/sdk-typescript',
    outcome: 'denied', exit: 3, reason: 'denied', denials: 7, deniedTools: ['PowerShell'],
  }
  const dir = runsDir({ 'jayostis__sdk-typescript.jsonl': jsonl([record]) })
  const { out } = audit(dir)

  assert.equal(out.candidates.length, 1)
  assert.equal(out.candidates[0].evidence[0].denials, 7,
    'the log records 7 denials across 1 de-duplicated tool name; evidence must not contradict the log it quotes')
  assert.deepEqual(out.candidates[0].evidence[0].deniedTools, ['PowerShell'], 'the tool list is a separate fact')
})

test('a run denied with no denials count is still classified as denied', () => {
  const record = {
    schema: 1, tool: 'pr-review', ts: '2026-08-28T20:03:11.001Z', repo: 'jayostis/sdk-typescript',
    outcome: 'denied', exit: 3, reason: 'denied', deniedTools: ['Bash', 'PowerShell'],
  }
  const dir = runsDir({ 'jayostis__sdk-typescript.jsonl': jsonl([record]) })
  const { out } = audit(dir)

  assert.deepEqual(out.candidates.map(c => c.kind), ['denied'],
    'the guard must keep firing on the tool list alone, whatever evidence reports as the count')
})

test('a tool named for an Object.prototype key is an unknown tool, not a crash', () => {
  const record = {
    schema: 1, tool: 'constructor', ts: '2026-08-28T20:03:11.001Z', repo: 'jayostis/sdk-typescript',
    outcome: 'ok', exit: 0, reason: 'from a writer this reader does not know',
  }
  const dir = runsDir({ 'jayostis__sdk-typescript.jsonl': jsonl([...RECORDS, record]) })
  const { out } = audit(dir)

  assert.ok(out.candidates.some(c => c.kind === 'unknown-tool'),
    'EXITS.constructor is inherited and truthy, so the unknown tool is not flagged and the exit check then throws')
  assert.equal(out.scanned, RECORDS.length + 1, 'and one odd string in `tool` must not take the whole sweep down')
})

test('the run log directory is read without being created, so a machine with no log says so', () => {
  const home = mkdtempSync(join(tmpdir(), 'baton-audit-fresh-'))
  const saved = process.env.BATON_HOME
  process.env.BATON_HOME = home
  try {
    const { printed, code } = auditRaw(['--repo', THIS_REPO, '--no-log'])
    assert.equal(code, 2, 'no log is a preflight, not a clean sweep of zero records')
    assert.match(printed, /does not exist/, 'the operator must not read "nothing to report" as "the log is clean"')
    assert.equal(existsSync(join(home, 'runs')), false, 'a read-only verb must not create the directory it is checking for')
  } finally {
    if (saved === undefined) delete process.env.BATON_HOME
    else process.env.BATON_HOME = saved
  }
})

test('a value-taking flag with no value is a preflight, not a silent default', () => {
  const trailing = auditRaw(['--repo', THIS_REPO, '--json', '--runs'])
  assert.equal(trailing.code, 2, '--runs with no value must not fall through to the real run log')
  assert.match(trailing.printed, /--runs/, 'and the diagnostic has to name the flag')

  const swallowed = auditRaw(['--repo', THIS_REPO, '--runs', '--json'])
  assert.equal(swallowed.code, 2, '--runs must not silently swallow the next flag as its value')

  for (const flag of ['--since', '--dir', '--repo']) {
    const r = auditRaw([flag])
    assert.equal(r.code, 2, flag + ' with no value must be a preflight')
    assert.match(r.printed, new RegExp(flag), flag + ' must be named in the diagnostic')
  }
})

test('an argument error still honours --no-log, on either side of the bad argument', () => {
  const saved = process.env.BATON_HOME
  for (const argv of [['--no-log', '--nope'], ['--nope', '--no-log']]) {
    const home = mkdtempSync(join(tmpdir(), 'baton-audit-badarg-'))
    process.env.BATON_HOME = home
    try {
      const { printed, code } = auditRaw(argv)
      assert.equal(code, 2, `an unrecognised argument is a preflight: ${argv.join(' ')}`)
      assert.match(printed, /--nope/, 'and the diagnostic has to name the argument it refused')
      assert.equal(existsSync(join(home, 'runs')), false,
        `--no-log was passed, so \`${argv.join(' ')}\` must not append the preflight record the auditor then reads back as its own noise`)
    } finally {
      if (saved === undefined) delete process.env.BATON_HOME
      else process.env.BATON_HOME = saved
    }
  }
})
