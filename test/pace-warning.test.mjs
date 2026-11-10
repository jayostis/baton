// The pace warning at dispatch time: the same PreToolUse Agent hook as the cap adds up to three lines of context when a pace
// flag is up. It warns and never blocks, says nothing when the data cannot be read, and caches by the newest input mtime.
// Run as the harness runs the hook: stdin JSON, and a hookSpecificOutput.additionalContext on stdout.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { analysisFor, CACHE_FILE, endsOf, flagLines } from '../scripts/lib/pace-warning.mjs'

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)).replace(/\\/g, '/')
const NOW = Date.now()
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString()

function world() {
  const base = mkdtempSync(join(tmpdir(), 'pace-'))
  const dir = join(base, 'sess')
  const subs = join(dir, 'subagents')
  const folder = join(base, 'epic')
  mkdirSync(subs, { recursive: true })
  mkdirSync(join(folder, 'notes'), { recursive: true })
  // An agent that ran from `from` to `to` minutes ago.
  const agent = (id, description, from, to, { finished = true } = {}) => {
    const line = (t, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: at(t), message: { content: [] }, ...extra })
    writeFileSync(join(subs, `agent-${id}.jsonl`), [line(from), line((from + to) / 2), line(to)].join('\n') + '\n')
    writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify({ description, toolUseId: `tu-${id}`, ...(finished ? { finished: true } : {}) }))
  }
  const runMd = (text) => writeFileSync(join(folder, 'run.md'), text)
  const waves = (w) => writeFileSync(join(folder, 'waves.json'), JSON.stringify(w))
  const events = (list) => writeFileSync(join(dir, 'baton-events.jsonl'), list.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const env = { ...process.env, BATON_HOME: base, BATON_EPIC: '1', BATON_MACHINE: '', BATON_EVENTS: '0', BATON_PROJECT_CONFIG: '', BATON_HEAVY_SLOTS: '2', BATON_HEAVY_AGENTS: '9', BATON_LIGHT_AGENTS: '10', BATON_MACHINE_FILE: join(base, 'machine.json'), BATON_HEAVY_EVENTS: join(base, 'none.jsonl') }
  const dispatch = (description, { prompt = `x\nnotes: ${join(folder, 'notes', 'step.md').replace(/\\/g, '/')}`, e = {} } = {}) => {
    const r = spawnSync(process.execPath, [script('dispatch-hook.mjs')], {
      input: JSON.stringify({ session_id: 's1', transcript_path: join(base, 'sess.jsonl'), cwd: base, tool_name: 'Agent', tool_use_id: 'new', tool_input: { description, prompt, model: 'sonnet' } }),
      encoding: 'utf8', env: { ...env, ...e },
    })
    let context = null
    if (r.stdout.trim()) {
      const out = JSON.parse(r.stdout)
      assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
      context = out.hookSpecificOutput.additionalContext
    }
    return { status: r.status, context, stderr: r.stderr }
  }
  return { base, dir, subs, folder, agent, runMd, waves, events, dispatch }
}

test('no flag, no output: a session with agents but nothing slow says nothing, and the dispatch passes', () => {
  const w = world()
  w.agent('a1', 'builder: w1 s01', 60, 40)
  w.agent('a2', 'builder: w1 s02', 60, 45)
  w.agent('a3', 'fix: w1 s01 words', 30, 25)
  w.runMd('# run\n')
  const r = w.dispatch('review-small: w1 s05')
  assert.deepEqual([r.status, r.context], [0, null])
  assert.equal(w.dispatch('builder: w1 s03').context, null, 'a step with no round yet')
})

test('flag: a step on its second or later round, with the reason it has repeated', () => {
  const w = world()
  w.agent('f1', 'fix: w3 s07b words', 90, 80)
  w.agent('f2', 'fix: w3 s07b words', 70, 60)
  w.agent('f3', 'fix: w3 s09 test', 70, 60)
  const r = w.dispatch('fix: w3 s07b words')
  assert.equal(r.status, 0)
  assert.equal(r.context, 'pace: w3 s07b at 3 rounds, 2 for "words". Sharpen before dispatching another fix.')
  assert.equal(w.dispatch('fix: w3 s11 words').context, null, 'another step is on its first round')
  assert.equal(w.dispatch('fix: w3 s09 test').context, 'pace: w3 s09 at 2 rounds. Sharpen before dispatching another fix.')
})

test('flag: one round reason seen twice with no Sharpened line in the run log since; a Sharpened line after both clears it', () => {
  const w = world()
  w.agent('aaa111', 'fix: w1 s01 words', 90, 80)
  w.agent('bbb222', 'fix: w2 s03 words', 70, 60)
  w.agent('ccc333', 'fix: w2 s04 test', 50, 40)
  w.runMd('# run\nfix: w1 s01 words (aaa111): ...\nfix: w2 s03 words (bbb222): ...\n')
  const open = w.dispatch('review-small: w3 s01')
  assert.equal(open.context, 'pace: "words" came up 2 times (w1 s01, w2 s03) with no Sharpened line in the run log since. Sharpen before dispatching another review-small.')
  w.runMd('# run\nfix: w1 s01 words (aaa111)\nfix: w2 s03 words (bbb222)\nSharpened: a words check in the findings template\n')
  assert.equal(w.dispatch('review-small: w3 s01').context, null)
  w.agent('ddd444', 'fix: w3 s05 words', 20, 10)
  w.agent('eee555', 'fix: w3 s06 words', 9, 5)
  w.runMd('# run\nfix: w1 s01 words (aaa111)\nfix: w2 s03 words (bbb222)\nSharpened: a words check\nfix: w3 s05 words (ddd444)\n')
  assert.match(w.dispatch('review-small: w3 s09').context, /"words" came up 2 times \(w3 s05, w3 s06\)/, 'the first two are covered; two more since are not')
  assert.equal(w.dispatch('review-small: w3 s09', { prompt: 'no run folder named here' }).context, null, 'no run log found: the check is skipped')
})

test('flag: an agent of the role being dispatched that ran past twice the role\'s median; running agents and other roles do not count', () => {
  const w = world()
  for (const [n, to] of [[1, 50], [2, 50], [3, 50]]) w.agent(`b${n}`, `builder: w1 s0${n}`, 60, to)
  w.agent('b4', 'builder: w1 s04', 100, 40)
  w.agent('b5', 'builder: w1 s05', 300, 0, { finished: false })
  w.agent('r1', 'review-small: w1 s01', 200, 10)
  const r = w.dispatch('builder: w2 s01')
  assert.equal(r.context, 'pace: builder w1 s04 at 6x median. Sharpen before dispatching another builder.')
  assert.equal(w.dispatch('review-small: w2 s01').context, null, 'one reviewer is its own median')
})

test('flag: slot waits over ten minutes in the current wave; a wait before the wave began or a short one does not count', () => {
  const w = world()
  w.agent('a1', 'builder: w3 s01', 60, 40)
  w.runMd('# run\n')
  w.waves({ w2: { from: at(300), to: at(200) }, w3: { from: at(120) } })
  w.events([
    { at: at(250), kind: 'heavy-wait', wait_s: 3000, cmd: 'pytest' },
    { at: at(60), kind: 'heavy-wait', wait_s: 300, cmd: 'pytest' },
  ])
  assert.equal(w.dispatch('review-small: w3 s02').context, null)
  appendFileSync(join(w.dir, 'baton-events.jsonl'), `${JSON.stringify({ at: at(30), kind: 'heavy-wait', wait_s: 840, cmd: 'node --test' })}\n`)
  assert.equal(w.dispatch('review-small: w3 s02').context, 'pace: slot waits of up to 14 min in w3. Sharpen before dispatching another review-small.')
})

test('at most three lines: four flags are folded into three', () => {
  const w = world()
  w.agent('f1', 'fix: w3 s07b words', 90, 80)
  w.agent('f2', 'fix: w3 s07b words', 70, 60)
  w.agent('f3', 'fix: w4 s01 words', 70, 60)
  for (const n of [1, 2, 3]) w.agent(`b${n}`, `fix: w9 s0${n}`, 20, 10)
  w.agent('b4', 'fix: w9 s04', 200, 10)
  w.runMd('# run\n')
  w.waves({ w3: { from: at(400) } })
  w.events([{ at: at(30), kind: 'heavy-wait', wait_s: 900 }])
  const lines = w.dispatch('fix: w3 s07b words').context.split('\n')
  assert.equal(lines.length, 3)
  assert.ok(lines.every((l) => l.startsWith('pace: ')))
  assert.match(lines[2], /fix w9 s04 at .*; slot waits of up to 15 min in w3\. Sharpen before dispatching another fix\.$/)
})

test('it warns and never blocks: a flag leaves a dispatch the cap would refuse refused, with no context, and one it passes is passed', () => {
  const w = world()
  w.agent('f1', 'fix: w3 s07b words', 90, 80)
  w.agent('f2', 'fix: w3 s07b words', 70, 60)
  assert.equal(w.dispatch('fix: w3 s07b words').status, 0)
  w.agent('h1', 'builder: x', 5, 0, { finished: false })
  const refused = w.dispatch('fix: w3 s07b words', { e: { BATON_HEAVY_AGENTS: '1' } })
  assert.equal(refused.status, 2)
  assert.equal(refused.context, null)
  assert.equal(w.dispatch('fix: w3 s07b words', { e: { BATON_EPIC: '' } }).context, null, 'outside an epic')
  assert.equal(w.dispatch('fix: w3 s07b words', { e: { BATON_MACHINE: '0' } }).context, null, 'BATON_MACHINE=0')
})

test('cache: a second read of the same inputs is not recomputed; a new agent, a touched transcript or an edited run log is', () => {
  const w = world()
  w.agent('a1', 'builder: w1 s01', 60, 40)
  w.runMd('# run\n')
  const first = analysisFor(w.dir, w.folder)
  assert.equal(first.cached, undefined)
  assert.ok(existsSync(join(w.dir, CACHE_FILE)))
  assert.equal(analysisFor(w.dir, w.folder).cached, true)
  const t = new Date(Date.now() + 5000)
  utimesSync(join(w.subs, 'agent-a1.jsonl'), t, t)
  assert.equal(analysisFor(w.dir, w.folder).cached, undefined, 'a transcript was written')
  assert.equal(analysisFor(w.dir, w.folder).cached, true)
  w.agent('a2', 'builder: w1 s02', 30, 20)
  assert.equal(analysisFor(w.dir, w.folder).rows.length, 2)
  const u = new Date(Date.now() + 9000)
  utimesSync(join(w.folder, 'run.md'), u, u)
  assert.equal(analysisFor(w.dir, w.folder).cached, undefined, 'the run log changed')
  writeFileSync(join(w.dir, CACHE_FILE), '{ torn')
  assert.equal(analysisFor(w.dir, w.folder).rows.length, 2, 'a torn cache is recomputed')
})

test('unreadable inputs stay silent: a run log that is a folder, junk in the events, a torn meta, a transcript with no timestamps', () => {
  const w = world()
  w.agent('f1', 'fix: w3 s07b words', 90, 80)
  w.agent('f2', 'fix: w3 s07b words', 70, 60)
  const baseline = w.dispatch('review-small: w3 s01')
  assert.equal(baseline.context, null)
  mkdirSync(join(w.folder, 'run.md'))
  writeFileSync(join(w.folder, 'waves.json'), 'not json')
  writeFileSync(join(w.dir, 'baton-events.jsonl'), 'junk\n{"kind":\n')
  writeFileSync(join(w.subs, 'agent-torn.meta.json'), '{ no')
  writeFileSync(join(w.subs, 'agent-blank.meta.json'), JSON.stringify({ description: 'builder: w3 s03' }))
  writeFileSync(join(w.subs, 'agent-blank.jsonl'), 'no timestamps here\n')
  const r = w.dispatch('review-small: w3 s01')
  assert.deepEqual([r.status, r.context], [0, null])
  assert.equal(w.dispatch('fix: w3 s07b words').context, 'pace: w3 s07b at 3 rounds, 2 for "words". Sharpen before dispatching another fix.', 'the flags that need no log still work')
  const none = spawnSync(process.execPath, [script('dispatch-hook.mjs')], { input: JSON.stringify({ session_id: 's1', tool_name: 'Agent', tool_input: { description: 'fix: w3 s07b words' } }), encoding: 'utf8', env: { ...process.env, BATON_EPIC: '1', BATON_MACHINE_FILE: join(w.base, 'm.json') } })
  assert.deepEqual([none.status, none.stdout], [0, ''])
})

test('the run folder comes from the project config\'s run_folders when the prompt names none', () => {
  const w = world()
  w.agent('aaa111', 'fix: w1 s01 words', 90, 80)
  w.agent('bbb222', 'fix: w2 s03 words', 70, 60)
  const root = join(w.base, 'epics')
  mkdirSync(join(root, 'old'), { recursive: true })
  mkdirSync(join(root, 'current'), { recursive: true })
  writeFileSync(join(root, 'old', 'run.md'), '# old\n')
  writeFileSync(join(root, 'current', 'run.md'), '# run\n')
  const past = new Date(Date.now() - 86400000)
  utimesSync(join(root, 'old', 'run.md'), past, past)
  const config = join(w.base, 'project.md')
  writeFileSync(config, `# c\n\n## run_folders\n\`${join(root, '<epic>').replace(/\\/g, '/')}/\`. Working state only.\n\n## next\n`)
  const r = w.dispatch('review-small: w3 s01', { prompt: 'nothing here', e: { BATON_PROJECT_CONFIG: config } })
  assert.match(r.context, /"words" came up 2 times/)
})

test('endsOf reads the first and last timestamp of a transcript from its two ends, a large one included', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pace-'))
  const file = join(dir, 'a.jsonl')
  const pad = 'x'.repeat(2000)
  const lines = [{ type: 'summary' }, ...Array.from({ length: 400 }, (_, i) => ({ type: 'user', timestamp: at(500 - i), pad })), { type: 'x' }]
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const [a, b] = endsOf(file)
  assert.equal(new Date(a).toISOString(), at(500))
  assert.equal(new Date(b).toISOString(), at(101))
  assert.equal(flagLines({ rows: [], unhandled: null, wave: null, slotWaitS: 0 }, 'builder: w1 s01').length, 0)
})
