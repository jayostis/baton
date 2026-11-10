// The epic's event log and the time report: the writer, the transcript time split, `ledger.mjs --time`, the round reasons,
// the sharpening slot, dispatch.mjs, and what heavy.sh records. Hooks and scripts are run as the harness runs them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendEvent, readEvents, scriptEventsPath, EVENTS_FILE, childSeconds, parsePairs, eventsPath } from '../scripts/lib/events.mjs'
import { timeSplit, kindOf, transcriptMerges } from '../scripts/lib/timing.mjs'
import { timeReport } from '../scripts/lib/time-report.mjs'
import { stepOf, reasonOf, reasonFromFindings } from '../scripts/lib/steps.mjs'
import { ledger, pace, main as ledgerMain } from '../scripts/ledger.mjs'
import { eventOf } from '../scripts/events-hook.mjs'
import { verdict as slots } from '../scripts/agent-slots.mjs'
import { limits } from '../scripts/lib/machine.mjs'
import { dispatch, render, reviewCall } from '../scripts/dispatch.mjs'

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)).replace(/\\/g, '/')
const tmp = (p = 'ev-') => mkdtempSync(join(tmpdir(), p))
const quiet = (fn) => {
  const log = console.log
  const out = []
  console.log = (...a) => out.push(a.join(' '))
  try { fn() } finally { console.log = log }
  return out.join('\n')
}

// ---- the writer

test('concurrent appends from separate processes interleave whole lines, none lost', async () => {
  const file = join(tmp(), 'baton-events.jsonl')
  const run = (n) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', `
      import(${JSON.stringify('file:///' + script('lib/events.mjs'))}).then(({ appendEvent }) => {
        for (let i = 0; i < 40; i++) appendEvent(${JSON.stringify(file)}, { kind: 'mark', label: 'w${n}', i, pad: 'x'.repeat(200) })
      })`], { stdio: 'ignore' })
    p.on('close', resolve)
  })
  await Promise.all([1, 2, 3, 4, 5, 6].map(run))
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 240)
  assert.equal(readEvents(file).length, 240, 'every line is whole JSON')
  assert.equal(new Set(readEvents(file).map((e) => `${e.label}/${e.i}`)).size, 240)
})

test('a missing session folder is created, a failed write returns false, and the record carries at and kind', () => {
  const file = join(tmp(), 'nope', 'deeper', EVENTS_FILE)
  assert.equal(appendEvent(file, { kind: 'mark', session: 's' }), true)
  const [e] = readEvents(file)
  assert.equal(e.kind, 'mark')
  assert.ok(Date.parse(e.at))
  const blocked = join(tmp(), 'file')
  writeFileSync(blocked, '')
  assert.equal(appendEvent(join(blocked, 'x', EVENTS_FILE), { kind: 'mark' }), false, 'a path under a file cannot be written, and does not throw')
})

test('a hook writes beside the session; a script finds the folder by the session id, else the machine-wide file', () => {
  const root = tmp()
  assert.equal(eventsPath({ transcript_path: join(root, 'p', 's1.jsonl') }), join(root, 'p', 's1', EVENTS_FILE))
  assert.match(eventsPath({ session_id: 's1' }, root), /machine.s1\.events\.jsonl$/)
  const config = join(root, 'cfg')
  mkdirSync(join(config, 'projects', 'proj'), { recursive: true })
  writeFileSync(join(config, 'projects', 'proj', 'sess9.jsonl'), '')
  const env = { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: 'sess9', BATON_HEAVY_EVENTS: join(root, 'loose.jsonl') }
  assert.equal(scriptEventsPath(env, '/elsewhere', root), join(config, 'projects', 'proj', 'sess9', EVENTS_FILE))
  assert.equal(scriptEventsPath({ ...env, CLAUDE_CODE_SESSION_ID: 'unknown' }, '/elsewhere', root), join(root, 'loose.jsonl'))
  assert.equal(scriptEventsPath({ ...env, CLAUDE_CODE_SESSION_ID: '' }, '/elsewhere', root), join(root, 'loose.jsonl'))
  assert.equal(scriptEventsPath({ ...env, BATON_EVENTS_FILE: join(root, 'forced.jsonl') }, '/elsewhere', root), join(root, 'forced.jsonl'))
})

test('event.mjs and mark.mjs append k=v pairs, number only what the key says is a number, and honour BATON_EVENTS=0', () => {
  const file = join(tmp(), 'e.jsonl')
  const env = { ...process.env, BATON_EVENTS_FILE: file, BATON_EVENTS: '', BATON_MACHINE: '' }
  assert.equal(spawnSync(process.execPath, [script('event.mjs'), 'merge', 'repo=a/b', 'pr=12', 'head=1234567'], { env }).status, 0)
  assert.equal(spawnSync(process.execPath, [script('mark.mjs'), 'wave-start', 'wave=w2'], { env, encoding: 'utf8' }).stdout.trim(), 'marked wave-start')
  const [m, k] = readEvents(file)
  assert.deepEqual([m.kind, m.repo, m.pr, m.head], ['merge', 'a/b', 12, '1234567'])
  assert.deepEqual([k.kind, k.label, k.wave], ['mark', 'wave-start', 'w2'])
  spawnSync(process.execPath, [script('event.mjs'), 'merge'], { env: { ...env, BATON_EVENTS: '0' } })
  assert.equal(readEvents(file).length, 2)
  assert.equal(spawnSync(process.execPath, [script('mark.mjs')], { env }).status, 2)
  assert.deepEqual(parsePairs(['a=1', 'wall_s=3.5', 'x=', 'bad']), { a: '1', wall_s: 3.5, x: '' })
  assert.equal(childSeconds('0m1.5s 2m0.25s'), 121.75, 'user plus system of the children line')
  assert.ok(Number.isNaN(childSeconds('')))
})

test('the hooks log a dispatch (role, weight, model, step), the id it launched as, and the handback', () => {
  const d = eventOf('dispatch', { tool_name: 'Agent', tool_use_id: 't1', tool_input: { description: 'fix: w3 s07b words', model: 'sonnet', effort: 'medium', prompt: '1. repo#5 x\n2. y' } })
  assert.deepEqual(d, { kind: 'dispatch', fields: { tool_use_id: 't1', description: 'fix: w3 s07b words', role: 'fix', weight: 'heavy', model: 'sonnet', effort: 'medium', step: 'w3 s07b', subject: '1. repo#5 x' } })
  assert.equal(eventOf('dispatch', { tool_name: 'Agent', tool_input: { description: 'cold-read: w1 s01 x' } }).fields.weight, 'light')
  assert.deepEqual(eventOf('launched', { tool_name: 'Agent', tool_use_id: 't1', tool_response: { status: 'async_launched', agentId: 'A1' } }).fields, { tool_use_id: 't1', agent: 'A1', status: 'async_launched' })
  assert.equal(eventOf('handback', { agent_id: 'A1' }).fields.agent, 'A1')
  assert.equal(eventOf('dispatch', { tool_name: 'Bash' }), null)
  const root = tmp()
  const run = (mode, input, env = {}) => spawnSync(process.execPath, [script('events-hook.mjs'), mode], { input: JSON.stringify({ session_id: 's', transcript_path: join(root, 's.jsonl'), ...input }), env: { ...process.env, BATON_EPIC: '1', BATON_EVENTS: '', ...env }, encoding: 'utf8' })
  assert.equal(run('dispatch', { tool_name: 'Agent', tool_use_id: 't1', tool_input: { description: 'builder: w1 s01 x', model: 'sonnet' } }).status, 0)
  run('launched', { tool_name: 'Agent', tool_use_id: 't1', tool_response: { status: 'async_launched', agentId: 'A1' } })
  run('handback', { agent_id: 'A1' })
  assert.deepEqual(readEvents(join(root, 's', EVENTS_FILE)).map((e) => e.kind), ['dispatch', 'launched', 'handback'])
  run('dispatch', { tool_name: 'Agent', tool_input: { description: 'x' } }, { BATON_EPIC: '' })
  run('dispatch', { tool_name: 'Agent', tool_input: { description: 'x' } }, { BATON_EVENTS: '0' })
  assert.equal(readEvents(join(root, 's', EVENTS_FILE)).length, 3, 'outside an epic, or switched off, nothing is written')
  assert.equal(spawnSync(process.execPath, [script('events-hook.mjs'), 'dispatch'], { input: 'junk' }).status, 0)
})

// ---- the transcript time split

const T0 = Date.parse('2026-11-10T10:00:00Z')
const at = (sec) => new Date(T0 + sec * 1000).toISOString()
const use = (sec, id, name, input) => JSON.stringify({ type: 'assistant', timestamp: at(sec), message: { id: `m${id}`, model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1, output_tokens: 1 } } })
const result = (sec, id) => JSON.stringify({ type: 'user', timestamp: at(sec), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const prompt = (sec, text) => JSON.stringify({ type: 'user', timestamp: at(sec), message: { role: 'user', content: text } })

test('the time split: wall, tool and model seconds, by kind, the five longest calls, parallel calls counted once', () => {
  const path = join(tmp(), 'agent-a.jsonl')
  writeFileSync(path, [
    prompt(0, '1. x'),
    use(2, 'g', 'Bash', { command: 'cd /w && git log --oneline | head -3' }), result(5, 'g'),
    use(9, 'h', 'Bash', { command: 'bash /p/scripts/heavy.sh node --test test/a.test.mjs' }), result(69, 'h'),
    use(70, 'c', 'Bash', { command: 'bash /p/scripts/wait-ci.sh jayostis/baton 5' }), result(170, 'c'),
    use(171, 'r', 'Read', { file_path: '/w/a.md' }), result(172, 'r'),
    use(175, 'p1', 'Edit', { file_path: '/w/a.md', old_string: 'a', new_string: 'b' }), use(175, 'p2', 'Write', { file_path: '/w/b.md', content: 'x' }), result(177, 'p1'), result(179, 'p2'),
    use(180, 'dangling', 'Bash', { command: 'sleep 99' }),
    JSON.stringify({ type: 'assistant', timestamp: at(181), message: { id: 'z', content: [{ type: 'text', text: 'done' }] } }),
  ].join('\n') + '\n')
  const s = timeSplit(path)
  const sec = (ms) => Math.round(ms / 1000)
  assert.equal(sec(s.wallMs), 181)
  assert.equal(sec(s.toolMs), 3 + 60 + 100 + 1 + 4, 'the parallel Edit and Write span 175 to 179 once')
  assert.equal(sec(s.modelMs), 181 - 168)
  assert.deepEqual(Object.fromEntries(Object.entries(s.kinds).map(([k, v]) => [k, sec(v)])), { heavy: 59, ci: 99, git: 3, read: 1, other: 6 })
  assert.deepEqual(s.top.map((t) => [t.tool, t.seconds]), [['Bash', 100], ['Bash', 60], ['Write', 4], ['Bash', 3], ['Edit', 2]])
  assert.equal(s.top[0].text, 'bash /p/scripts/wait-ci.sh jayostis/baton 5')
  assert.equal(timeSplit(join(tmp(), 'missing.jsonl')), null)
})

test('a call is heavy, CI wait, git, read or other by what it runs; a grep for a runner is not a run', () => {
  const k = (command) => kindOf('Bash', { command })
  assert.equal(k('cd a && python3 -m pytest -n auto'), 'heavy')
  assert.equal(k('node --import ./x.js --test dist/*.test.js'), 'heavy')
  assert.equal(k('timeout 170 bash -c "until [ -s f ]; do sleep 10; done"'), 'heavy')
  assert.equal(k('until gh run view 1 | grep -q completed; do sleep 20; done'), 'ci')
  assert.equal(k('grep -rn pytest docs | head'), 'read')
  assert.equal(k('bash x/wait-ci.sh a/b 3'), 'ci')
  assert.equal(k('cd w && git status && gh pr view 3'), 'git')
  assert.equal(k('bash gate.sh a/b 3'), 'git')
  assert.equal(k('cat a | head -5; ls'), 'read')
  assert.equal(k('node scripts/gen.mjs'), 'other')
  assert.equal(kindOf('Grep', { pattern: 'x' }), 'read')
  assert.equal(kindOf('Edit', {}), 'other')
})

test('the orchestrator\'s gate.sh --merge calls whose result says merged stand in for merge events', () => {
  const path = join(tmp(), 'sess.jsonl')
  writeFileSync(path, [
    use(10, 'm1', 'Bash', { command: 'G=/b/gate.sh; bash $G jayostis/r 12 --merge | tail -3 && bash $G jayostis/q 7 --merge | tail -3' }),
    JSON.stringify({ type: 'user', timestamp: at(20), message: { content: [{ type: 'tool_result', tool_use_id: 'm1', content: 'GATE PASSES\nmerged\n' }] } }),
    use(30, 'm2', 'Bash', { command: 'bash /b/gate.sh jayostis/r 13 --merge' }),
    JSON.stringify({ type: 'user', timestamp: at(40), message: { content: [{ type: 'tool_result', tool_use_id: 'm2', content: [{ type: 'text', text: 'GATE DOES NOT PASS' }] }] } }),
  ].join('\n') + '\n')
  assert.deepEqual(transcriptMerges(path).map((m) => [m.repo, m.pr, m.at]), [['jayostis/r', 12, at(20)]], 'one merged line, so the first PR of the call; a refusal merges nothing')
})

// ---- --time

function agentFile(dir, id, description, records) {
  mkdirSync(join(dir, 'subagents'), { recursive: true })
  writeFileSync(join(dir, 'subagents', `agent-${id}.jsonl`), records.join('\n') + '\n')
  writeFileSync(join(dir, 'subagents', `agent-${id}.meta.json`), JSON.stringify({ description, finished: true }))
}
const min = (m) => m * 60

// Two builders in one wave overlap, each with one heavy run; a reviewer and a fix follow the first; the PR merges at 60.
function fixture({ withEvents = true } = {}) {
  const project = tmp('time-')
  const dir = join(project, 'sess')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(project, 'sess.jsonl'), [
    JSON.stringify({ type: 'assistant', timestamp: at(0), message: { id: 'o', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } } }),
    use(min(59), 'mg', 'Bash', { command: 'bash /b/gate.sh jayostis/r 12 --merge' }),
    JSON.stringify({ type: 'user', timestamp: at(min(60)), message: { content: [{ type: 'tool_result', tool_use_id: 'mg', content: 'merged' }] } }),
  ].join('\n') + '\n')
  const turn = (sec) => JSON.stringify({ type: 'assistant', timestamp: at(sec), message: { id: `t${sec}`, model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 1, cache_read_input_tokens: 1000, output_tokens: 1 } } })
  agentFile(dir, 'b1', 'builder: w1 s01 build', [prompt(0, '1. jayostis/r#5 build'), use(min(5), 'h', 'Bash', { command: 'bash /p/heavy.sh node --test x' }), result(min(15), 'h'), turn(min(20))])
  agentFile(dir, 'b2', 'builder: w1 s02 other', [prompt(0, '1. jayostis/r#6 other'), use(min(5), 'h', 'Bash', { command: 'bash /p/heavy.sh pytest -k y' }), result(min(14), 'h'), turn(min(18))])
  agentFile(dir, 'v1', 'review-small: w1 s01 review', [prompt(min(25), '1. jayostis/r#12 review'), turn(min(30))])
  agentFile(dir, 'f1', 'fix: w1 s01 ci-red x', [prompt(min(40), '1. jayostis/r#12 fix'), turn(min(50))])
  if (withEvents) {
    const e = (kind, sec, f) => JSON.stringify({ at: at(sec), kind, session: 'sess', ...f })
    writeFileSync(join(dir, EVENTS_FILE), [
      e('heavy-start', min(5) + 5, { cmd: 'node --test x', wait_s: 90, cwd: 'C:\\w\\s01' }),
      e('heavy-start', min(5) + 6, { cmd: 'pytest -k y', wait_s: 0, cwd: 'C:\\w\\s02' }),
      e('heavy-end', min(15), { cmd: 'node --test x', cpu_s: 42, machine_cpu_s: 50, wall_s: 600, exit: 0, cwd: 'C:\\w\\s01' }),
      e('heavy-end', min(14), { cmd: 'pytest -k y', machine_cpu_s: 7, wall_s: 540, exit: 0, cwd: 'C:\\w\\s02' }),
      e('ci-wait-end', min(55), { repo: 'jayostis/r', pr: 12, result: 'passed', wall_s: 600 }),
    ].join('\n') + '\n')
  }
  return { project, dir }
}

test('--time: per step the wall to merge, agent minutes, heavy cpu and slot wait joined by command, CI wait and the orchestrator\'s latency', () => {
  const { dir } = fixture()
  const out = quiet(() => assert.equal(ledgerMain([dir, '--time']), 0))
  const row = (key) => out.split('\n').find((l) => l.startsWith(`| ${key} |`)).split('|').map((c) => c.trim()).slice(1, -1)
  // step wall agents model tools heavy CI slot cpu units peak rounds latency
  const s1 = row('w1 s01')
  assert.deepEqual([s1[1], s1[2], s1[3], s1[4], s1[5], s1[6], s1[7], s1[8]], ['60', '35', '25', '10', '8.5', '10', '1.5', '42'])
  assert.equal(s1[11], '1 ci-red')
  assert.equal(s1[12], '25', 'builder to reviewer 5, reviewer to fix 10, fix to merge 10')
  const s2 = row('w1 s02')
  assert.deepEqual([s2[1], s2[8]], ['18*', '~7'], 'no merge seen: the wall runs to the last handback; no cpu_s, so the machine-wide figure, marked')
  assert.match(out, /Events: heavy-start 2, heavy-end 2, ci-wait-end 1./)
  assert.match(out, /Merges mapped to a step: 1 of 1/)
  assert.match(out, /^w1: 2 steps\. model \d+%, heavy \d+%, CI wait \d+%, orchestrator latency \d+%, slot wait \d+%/m)
  assert.match(out, /^epic: .*\n(sink \d\..*\n){3}fix rounds by reason: ci-red 1/m)
})

test('--time with no events log stands on the transcripts: the merge comes from the gate call, heavy from the tool calls', () => {
  const { dir } = fixture({ withEvents: false })
  const out = quiet(() => ledgerMain([dir, '--time']))
  const s1 = out.split('\n').find((l) => l.startsWith('| w1 s01 |')).split('|').map((c) => c.trim()).slice(1, -1)
  assert.deepEqual([s1[1], s1[5], s1[6], s1[7], s1[8]], ['60', '10', '0', '0', '-'])
  assert.match(out, /Events: none, so transcripts only/)
})

test('--time is short by default and lists every step with --all', () => {
  const { dir } = fixture()
  const agents = []
  for (let i = 10; i < 40; i++) agents.push([`s${i}`, `builder: w2 s${i} x`])
  for (const [id, d] of agents) agentFile(dir, id, d, [prompt(min(70), '1. x'), JSON.stringify({ type: 'assistant', timestamp: at(min(71)), message: { id: id, model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } } })])
  const lines = (a) => quiet(() => ledgerMain([dir, '--time', ...a])).split('\n')
  assert.ok(lines([]).length <= 26, `${lines([]).length} lines`)
  assert.match(lines([]).join('\n'), /more steps \(--all\)/)
  assert.ok(lines(['--all']).filter((l) => l.startsWith('| w2')).length === 30)
})

test('the report reads the fallback events by time and directory when two agents ran at once', () => {
  const { dir } = fixture({ withEvents: false })
  const rows = ledger(dir, undefined, undefined, undefined, false, { time: true })
  const e = (kind, sec, f) => ({ at: at(sec), kind, ...f })
  const r = timeReport({ rows, events: [e('heavy-end', min(15), { cmd: 'node --test x', cpu_s: 11 }), e('heavy-end', min(14), { cmd: 'pytest -k y', cpu_s: 5 })], merges: [], session: 'sess' })
  const cpu = (key) => r.steps.find((s) => s.key === key).cpuS
  assert.deepEqual([cpu('w1 s01'), cpu('w1 s02')], [11, 5])
})

// ---- round reasons

test('a fix round\'s reason is the word after its step key; a findings file opens with Reason:', () => {
  assert.equal(reasonOf('fix: w3 s07b words'), 'words')
  assert.equal(reasonOf('fix: w1 s00 #665 review round'), 'review')
  assert.equal(reasonOf('fix: w2 s06d ci-red log'), 'ci-red')
  assert.equal(reasonOf('fix: w2 s06d flake'), 'flake')
  assert.equal(reasonOf('fix: w2 s06d round 2'), 'other')
  assert.equal(reasonOf('fix: no step here test'), 'other')
  assert.equal(stepOf('fix: w3 s07b words'), 'w3 s07b')
  assert.equal(reasonFromFindings('Reason: Conflict\n\n1. x'), 'conflict')
  assert.equal(reasonFromFindings('Reason: because\n'), 'other')
  assert.equal(reasonFromFindings('# findings\n1. x'), null)
})

test('--pace counts fix rounds by reason across steps and flags a reason seen twice, but not other', () => {
  const t = (n) => ({ start: at(n), end: at(n + 60), minutes: 1 })
  const row = (agent, n) => ({ agent, id: agent, ...t(n) })
  const p = pace([row('fix: w1 s01 words', 0), row('fix: w1 s02 words', 100), row('fix: w1 s03 test', 200), row('fix: w1 s04 round 1', 300), row('fix: w1 s05 round 1', 400)])
  assert.deepEqual(p.reasons, { words: 2, test: 1, other: 2 })
  assert.equal(p.flags.length, 1)
  assert.match(p.flags[0], /^words: 2 fix rounds \(w1 s01, w1 s02\)/)
})

// ---- the sharpening slot

const desc = (description) => ({ tool_name: 'Agent', tool_use_id: 'tu', tool_input: { description, prompt: 'x' } })
const heavy = (at, extra = {}) => ({ id: `t${at}`, agent_id: null, description: `builder: ${at}`, weight: 'heavy', at, ...extra })
const lim = limits({ cpuCount: 8, memBytes: 16 * 2 ** 30, env: {} })

test('one sharpen agent runs past the caps and takes no place from the others; a second waits like any other', () => {
  const full = [heavy(1), heavy(2), heavy(3)]
  assert.equal(slots(desc('builder: w1 s09'), { epic: true, running: full, lim }).block, true)
  const first = slots(desc('sharpen: w1 gate on changed files'), { epic: true, running: full, lim })
  assert.equal(first.block, false)
  assert.equal(first.entry.sharpen, true)
  const withSharpen = [...full, first.entry]
  const second = slots(desc('sharpen: w1 another'), { epic: true, running: withSharpen, lim })
  assert.equal(second.block, true)
  assert.match(second.reason, /3 heavy agents are running and the cap is 3/)
  assert.equal(slots(desc('sharpen: w1 another'), { epic: true, running: [heavy(1), first.entry], lim }).block, false, 'with room under the cap a second is an ordinary heavy agent')
  assert.equal(slots(desc('builder: w1 s09'), { epic: true, running: [heavy(1), heavy(2), first.entry], lim }).block, false, 'the sharpening agent does not count against the others')
  assert.equal(slots(desc('sharpen: x'), { epic: false, running: full, lim }).block, false)
})

// ---- dispatch.mjs

function config() {
  const dir = tmp('cfg-')
  const path = join(dir, 'project.md')
  writeFileSync(path, '# c\n\n## review_worktree\nA standing worktree.\n\n    bash C:\\t\\review-wt.sh <repo> <pr|sha|ref> [--partners] [--slot <n>]\n    bash C:\\t\\review-wt.sh cleanup\n\n## next\n    not this\n')
  return path
}

test('dispatch.mjs prints the description, model and the five lines, with the review call and its slot for a reviewer', () => {
  const env = { BATON_PROJECT_CONFIG: config() }
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
  const b = dispatch({ role: 'builder', step: 'w3 s07b', subject: 'jayostis/r#9 the step', input: join(tmp(), 'step.md') }, { env })
  assert.equal(b.description, 'builder: w3 s07b jayostis/r#9 the step')
  assert.deepEqual([b.model, b.effort], ['sonnet', 'high'])
  assert.equal(b.lines.length, 5)
  assert.deepEqual([b.lines[0], b.lines[1], b.lines[3], b.lines[4]], ['jayostis/r#9 the step', `${root}/skills/epic/builder.md`, root, env.BATON_PROJECT_CONFIG.replace(/\\/g, '/')])
  assert.match(b.lines[2], /step\.md$/)
  assert.equal(b.review, null)
  const r = dispatch({ role: 'review-small', step: 'w3 s07b', subject: 'jayostis/r#10', slot: '2' }, { env })
  assert.equal(r.lines[1], `${root}/skills/epic/reviewer.md`)
  assert.equal(r.lines[2], '')
  assert.equal(r.review, 'bash C:\\t\\review-wt.sh <repo> <pr|sha|ref> [--partners] --slot 2')
  assert.equal(render(r).split('\n').at(-1), `review_worktree: ${r.review}`)
  assert.equal(reviewCall('## review_worktree\n```\nbash x.sh <repo> [--slot <n>]\n```\n', '1'), 'bash x.sh <repo> --slot 1')
  assert.equal(reviewCall('## other\n    x\n', '1'), null)
})

test('dispatch.mjs leaves lines 4 and 5 of a cold-read blank, takes a fix round\'s reason from its findings file, and refuses a bad step key', () => {
  const env = { BATON_PROJECT_CONFIG: config() }
  const c = dispatch({ role: 'cold-read', step: 'w2 s06a', subject: 'the page text', brief: '/notes/cold.md', input: '/notes/page.txt' }, { env: {} })
  assert.equal(c.lines[0], 'the page text')
  assert.ok(c.lines[1].endsWith('/notes/cold.md'))
  assert.ok(c.lines[2].endsWith('/notes/page.txt'))
  assert.equal(c.lines[3], '')
  assert.equal(c.lines[4], '')
  assert.equal(c.model, null, 'a cold-read is not in the role table: the model is the project\'s call')
  const findings = join(tmp(), 'findings.md')
  writeFileSync(findings, 'Reason: ci-red\n\n1. a\n')
  const f = dispatch({ role: 'fix', step: 'w3 s07b', subject: 'jayostis/r#9 three findings', input: findings }, { env })
  assert.match(f.description, /^fix: w3 s07b ci-red jayostis\/r#9/)
  assert.equal(reasonOf(f.description), 'ci-red')
  assert.deepEqual([f.model, f.effort], ['sonnet', 'medium'])
  const none = dispatch({ role: 'fix', step: 'w3 s07b', subject: 'x', input: '/missing.md' }, { env })
  assert.match(none.description, /^fix: w3 s07b other /)
  assert.match(none.notes[0], /Reason:/)
  assert.throws(() => dispatch({ role: 'builder', step: 'w3', subject: 'x' }, { env }), /not a wave and a step/)
  assert.throws(() => dispatch({ role: 'nobody', step: 'w3 s07b', subject: 'x' }, { env }), /unknown role/)
  assert.throws(() => dispatch({ role: 'builder', step: 'w3 s07b', subject: 'x' }, { env: {}, cwd: tmp() }), /no project config/)
  const sharpen = dispatch({ role: 'sharpen', step: 'w1 s00', subject: 'the top sink' }, { env })
  assert.match(sharpen.lines[1], /skills\/epic\/builder\.md$/)
  const cli = spawnSync(process.execPath, [script('dispatch.mjs'), 'builder', 'w1 s01', 'sub'], { env: { ...process.env, ...env }, encoding: 'utf8' })
  assert.equal(cli.status, 0)
  assert.match(cli.stdout, /^description: builder: w1 s01 sub\nmodel: sonnet\neffort: high\n---\n1\. sub\n2\. /)
  assert.equal(spawnSync(process.execPath, [script('dispatch.mjs'), 'builder', 'nope', 'sub'], { env: { ...process.env, ...env } }).status, 2)
})

// ---- heavy.sh's events

const BASH = process.env.BATON_TEST_BASH || 'bash'
const haveBash = spawnSync(BASH, ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok'
const bashIt = haveBash ? test : test.skip

const heavyEnv = (d, file, extra = {}) => ({ ...process.env, BATON_HEAVY_DIR: d.replace(/\\/g, '/'), BATON_HEAVY_SLOTS: '1', BATON_MACHINE: '', BATON_EVENTS: '', BATON_HEAVY_HELD: '', BATON_EVENTS_FILE: file.replace(/\\/g, '/'), BATON_HEAVY_POLL: '0.2', ...extra })

bashIt('heavy.sh records the command, its wall seconds, its exit code and its cpu: bash\'s children where it counts them, else the machine\'s', () => {
  const d = tmp('hv-')
  const file = join(d, 'e.jsonl')
  const spin = ['bash', '-c', 'i=0; while [ $i -lt 30000 ]; do i=$((i+1)); done; exit 3']
  const r = spawnSync(BASH, [script('heavy.sh'), ...spin], { env: heavyEnv(d, file, { BATON_HEAVY_TIMES: '1' }), encoding: 'utf8' })
  assert.equal(r.status, 3, 'the command\'s exit code is heavy.sh\'s')
  const [start, end] = readEvents(file)
  assert.deepEqual([start.kind, end.kind], ['heavy-start', 'heavy-end'])
  assert.equal(end.cmd, spin.join(' ').slice(0, 120))
  assert.equal(end.exit, 3)
  assert.equal(end.wait_s, 0)
  assert.ok(Number.isInteger(end.wall_s) && end.wall_s >= 0)
  assert.equal(typeof end.cwd, 'string')
  assert.ok(end.cpu_s > 0, `cpu_s ${end.cpu_s}: times counted the bash child's loop`)
  assert.ok(end.machine_cpu_s >= 0)
  assert.equal(existsSync(join(d, 'slot-1')), false, 'the slot is released')
  const plain = spawnSync(BASH, [script('heavy.sh'), 'bash', '-c', 'exit 0'], { env: heavyEnv(d, join(d, 'p.jsonl'), { BATON_EVENTS: '0' }) })
  assert.equal(plain.status, 0)
  assert.equal(existsSync(join(d, 'p.jsonl')), false, 'BATON_EVENTS=0 writes nothing')
})

bashIt('heavy.sh records the seconds it waited for a slot, as heavy-wait and on heavy-start and heavy-end', async () => {
  const d = tmp('hv-')
  const file = join(d, 'e.jsonl')
  const holder = spawn(BASH, [script('heavy.sh'), 'sleep', '2'], { env: heavyEnv(d, join(d, 'holder.jsonl')), stdio: 'ignore' })
  for (let i = 0; i < 50 && !existsSync(join(d, 'slot-1', 'pid')); i++) await new Promise((r) => setTimeout(r, 100))
  const r = spawnSync(BASH, [script('heavy.sh'), 'echo', 'ran'], { env: heavyEnv(d, file), encoding: 'utf8' })
  assert.equal(r.status, 0)
  const events = readEvents(file)
  assert.deepEqual(events.map((e) => e.kind), ['heavy-wait', 'heavy-start', 'heavy-end'])
  assert.ok(events.every((e) => e.wait_s >= 1), JSON.stringify(events.map((e) => e.wait_s)))
  await new Promise((r) => holder.on('close', r))
})
