// The dispatch cap: one PreToolUse hook on Agent that counts the running agents from Claude Code's own files
// (<session-dir>/subagents/agent-*.meta.json and the transcripts beside them) and keeps no state of its own. The hook is
// run as the harness runs it (documented stdin, exit code, stderr); verdict() is called directly for the cases.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { limits, runningAgents, STALE_AGENT_MS } from '../scripts/lib/machine.mjs'
import { verdict } from '../scripts/dispatch-hook.mjs'

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)).replace(/\\/g, '/')
const GB = 2 ** 30
const lim = (o = {}) => limits({ cpuCount: 8, memBytes: 16 * GB, env: {}, ...o })
const desc = (description) => ({ tool_name: 'Agent', tool_use_id: 'tu', tool_input: { description, prompt: 'x', model: 'sonnet' } })
const running = (weight, description, quietMs = 60000) => ({ id: description, description, weight, quietMs })

test('verdict: under the cap passes; at the cap refuses, naming the running agents of that weight only', () => {
  const heavy = [running('heavy', 'builder: w1 s01', 60000), running('heavy', 'fix: w1 s02 words', 120000)]
  assert.equal(verdict(desc('builder: w1 s03'), { epic: true, running: heavy, lim: lim() }).block, false)
  const at = verdict(desc('builder: w1 s03'), { epic: true, running: [...heavy, running('heavy', 'builder: w1 s04', 1000)], lim: lim() })
  assert.equal(at.block, true)
  assert.match(at.reason, /3 heavy agents are running and the cap is 3/)
  assert.match(at.reason, /builder: w1 s01 \(quiet 1 min\); fix: w1 s02 words \(quiet 2 min\); builder: w1 s04/)
  assert.match(at.reason, /Wait for a handback/)
  const light = Array.from({ length: 9 }, (_, i) => running('light', `review-small: w1 s0${i}`))
  assert.equal(verdict(desc('review-small: w1 s09'), { epic: true, running: [...heavy, ...heavy, ...light], lim: lim() }).block, false, 'heavy agents do not count against light')
  assert.equal(verdict(desc('review-small: w1 s09'), { epic: true, running: [...light, running('light', 'walk: w1')], lim: lim() }).block, true)
  assert.equal(verdict(desc('builder: w1 s01'), { epic: true, running: [...light, ...light], lim: lim() }).block, false, 'light agents do not count against heavy')
})

test('verdict: one sharpen agent runs past the caps and takes no place from the others; a second waits like any other', () => {
  const full = [running('heavy', 'builder: 1'), running('heavy', 'builder: 2'), running('heavy', 'builder: 3')]
  assert.equal(verdict(desc('builder: w1 s09'), { epic: true, running: full, lim: lim() }).block, true)
  assert.equal(verdict(desc('sharpen: w1 gate on changed files'), { epic: true, running: full, lim: lim() }).block, false)
  const withSharpen = [...full, running('heavy', 'sharpen: w1 gate')]
  const second = verdict(desc('sharpen: w1 another'), { epic: true, running: withSharpen, lim: lim() })
  assert.equal(second.block, true)
  assert.match(second.reason, /3 heavy agents are running and the cap is 3/)
  assert.equal(verdict(desc('sharpen: w1 another'), { epic: true, running: [full[0], running('heavy', 'sharpen: w1 gate')], lim: lim() }).block, false, 'with room under the cap a second is an ordinary heavy agent')
  assert.equal(verdict(desc('builder: w1 s09'), { epic: true, running: [full[0], full[1], running('heavy', 'sharpen: w1 gate')], lim: lim() }).block, false, 'the sharpening agent does not count against the others')
})

test('verdict: outside an epic, with BATON_MACHINE=0, or for any tool but Agent, nothing is refused', () => {
  const full = Array.from({ length: 12 }, (_, i) => running('heavy', `builder: ${i}`))
  assert.deepEqual(verdict(desc('builder: x'), { epic: false, running: full, lim: lim() }), { block: false })
  assert.deepEqual(verdict(desc('builder: x'), { epic: true, env: { BATON_MACHINE: '0' }, running: full, lim: lim() }), { block: false })
  assert.deepEqual(verdict({ tool_name: 'Bash', tool_input: {} }, { epic: true, running: full, lim: lim() }), { block: false })
})

// ---- runningAgents, on the files Claude Code writes

function session() {
  const base = mkdtempSync(join(tmpdir(), 'disp-'))
  const dir = join(base, 'sess')
  const subs = join(dir, 'subagents')
  const agent = (id, description, { finished = false, quietMin = 1, toolUseId = `tu-${id}`, transcript = true } = {}) => {
    mkdirSync(subs, { recursive: true })
    writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description, toolUseId, ...(finished ? { finished: true } : {}) }))
    if (transcript) writeFileSync(join(subs, `agent-${id}.jsonl`), '{}\n')
    const t = new Date(Date.now() - quietMin * 60000)
    utimesSync(join(subs, `agent-${id}.meta.json`), t, t)
    if (transcript) utimesSync(join(subs, `agent-${id}.jsonl`), t, t)
  }
  const machineFile = join(base, 'baton-machine.json')
  const env = { ...process.env, BATON_HOME: base, BATON_EPIC: '1', BATON_MACHINE: '', BATON_PROJECT_CONFIG: '', BATON_HEAVY_SLOTS: '2', BATON_HEAVY_AGENTS: '3', BATON_LIGHT_AGENTS: '10', BATON_MACHINE_FILE: machineFile, BATON_EVENTS: '0' }
  const run = (description, e = {}, input = {}) => {
    const r = spawnSync(process.execPath, [script('dispatch-hook.mjs')], {
      input: JSON.stringify({ session_id: 's1', transcript_path: join(base, 'sess.jsonl'), cwd: base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'new', tool_input: { description, prompt: 'x', model: 'sonnet' }, ...input }),
      encoding: 'utf8', env: { ...env, ...e },
    })
    return { status: r.status, stderr: r.stderr, stdout: r.stdout }
  }
  return { base, dir, subs, agent, run, machineFile }
}

test('runningAgents: not finished and written within 90 minutes; a finished agent and a stale one are not running', () => {
  const s = session()
  s.agent('a1', 'builder: w1 s01', { quietMin: 5 })
  s.agent('a2', 'review-small: w1 s01')
  s.agent('a3', 'builder: w1 s02', { finished: true })
  s.agent('a4', 'builder: w1 s03', { quietMin: STALE_AGENT_MS / 60000 + 1 })
  s.agent('a5', 'fix: w1 s04', { transcript: false })
  const got = runningAgents(s.dir).map((a) => [a.description, a.weight]).sort()
  assert.deepEqual(got, [['builder: w1 s01', 'heavy'], ['fix: w1 s04', 'heavy'], ['review-small: w1 s01', 'light']])
  assert.deepEqual(runningAgents(s.dir, { exceptToolUse: 'tu-a1' }).map((a) => a.id).sort(), ['a2', 'a5'])
  assert.deepEqual(runningAgents(join(s.base, 'nothing')), [])
})

// ---- the hook, as run

test('hook: under the cap passes, at the cap refuses naming the running agents, a handback frees a place', () => {
  const s = session()
  s.agent('a1', 'builder: s1')
  s.agent('a2', 'builder: s2')
  assert.equal(s.run('builder: s3').status, 0, 'two running, cap three')
  s.agent('a3', 'fix: s3 words')
  const refused = s.run('builder: s4')
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /3 heavy agents are running and the cap is 3/)
  assert.match(refused.stderr, /builder: s1.*builder: s2.*fix: s3 words/)
  assert.equal(s.run('review-small: s1').status, 0, 'a reviewer is light')
  s.agent('a1', 'builder: s1', { finished: true })
  assert.equal(s.run('builder: s4').status, 0, 'Claude Code marked a1 finished')
  s.agent('a4', 'builder: s4')
  assert.equal(s.run('builder: s5').status, 2)
})

test('hook: a stale agent does not count, so a resumed session recovers once its 90 quiet minutes are up', () => {
  const s = session()
  for (const n of [1, 2, 3]) s.agent(`a${n}`, `builder: s${n}`, { quietMin: 30 })
  assert.equal(s.run('builder: s4').status, 2, 'killed by a restart 30 minutes ago, no finished: still counted')
  for (const n of [1, 2, 3]) s.agent(`a${n}`, `builder: s${n}`, { quietMin: 91 })
  assert.equal(s.run('builder: s4').status, 0)
})

test('hook: one sharpen agent passes the cap; outside an epic, with BATON_MACHINE=0 or on another tool nothing is refused', () => {
  const s = session()
  for (const n of [1, 2, 3]) s.agent(`a${n}`, `builder: s${n}`)
  assert.equal(s.run('builder: s4').status, 2)
  assert.equal(s.run('sharpen: w1 gate').status, 0)
  s.agent('a4', 'sharpen: w1 gate')
  assert.equal(s.run('sharpen: w1 another').status, 2, 'a second sharpen waits like any other')
  assert.equal(s.run('builder: s4', { BATON_EPIC: '' }).status, 0)
  assert.equal(s.run('builder: s4', { BATON_MACHINE: '0' }).status, 0)
  assert.equal(s.run('builder: s4', {}, { tool_name: 'Bash' }).status, 0)
})

test('hook fails open: no subagents folder, an unparsable meta, no transcript path, or garbage on stdin lets the dispatch through', () => {
  const s = session()
  assert.equal(s.run('builder: s1').status, 0, 'a fresh session has no subagents folder')
  assert.equal(s.run('builder: s1').stderr, '')
  for (const n of [1, 2, 3]) s.agent(`a${n}`, `builder: s${n}`)
  writeFileSync(join(s.subs, 'agent-bad.meta.json'), '{ not json')
  const open = s.run('builder: s4')
  assert.equal(open.status, 0)
  assert.match(open.stderr, /baton dispatch hook: .*dispatch allowed/)
  assert.equal(open.stderr.trim().split('\n').length, 1, 'one line')
  assert.equal(s.run('builder: s4', {}, { transcript_path: undefined }).status, 0)
  assert.equal(spawnSync(process.execPath, [script('dispatch-hook.mjs')], { input: 'garbage', encoding: 'utf8' }).status, 0)
})

test('hook: writes the limits it resolved, from the project config, for heavy.sh to read', () => {
  const s = session()
  const config = join(s.base, 'project.md')
  writeFileSync(config, '## machine\nheavy_slots: 5\nheavy_agents: 7\n')
  s.run('builder: s1', { BATON_PROJECT_CONFIG: config, BATON_HEAVY_SLOTS: '', BATON_HEAVY_AGENTS: '' })
  const f = JSON.parse(readFileSync(s.machineFile, 'utf8'))
  assert.deepEqual([f.heavy_slots, f.heavy_agents, f.light_agents], [5, 7, 10])
  const read = spawnSync(process.execPath, [script('machine.mjs')], { encoding: 'utf8', cwd: s.base, env: { ...process.env, BATON_MACHINE_FILE: s.machineFile, BATON_HEAVY_SLOTS: '', BATON_HEAVY_AGENTS: '', BATON_LIGHT_AGENTS: '', BATON_PROJECT_CONFIG: '' } })
  assert.match(read.stdout, /^5 7 10 \d+\s*$/)
  const env = spawnSync(process.execPath, [script('machine.mjs')], { encoding: 'utf8', cwd: s.base, env: { ...process.env, BATON_MACHINE_FILE: s.machineFile, BATON_HEAVY_SLOTS: '3', BATON_PROJECT_CONFIG: '' } })
  assert.match(env.stdout, /^3 /, 'BATON_HEAVY_SLOTS wins over the file')
  const none = spawnSync(process.execPath, [script('machine.mjs')], { encoding: 'utf8', cwd: s.base, env: { ...process.env, BATON_MACHINE_FILE: join(s.base, 'missing.json'), BATON_HEAVY_SLOTS: '', BATON_PROJECT_CONFIG: '' } })
  assert.match(none.stdout, /^\d+ \d+ 10 \d+\s*$/, 'no file: the machine defaults')
  assert.equal(existsSync(join(s.base, 'sess', 'baton-agents.json')), false, 'no state file of its own')
  assert.deepEqual(readdirSync(s.base).filter((n) => /lock|agents/.test(n)), [])
})
