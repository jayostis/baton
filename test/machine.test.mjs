// The machine's limits as hooks: caps on agents by weight, and heavy commands only through heavy.sh. The hooks are run as
// the harness runs them (documented stdin, exit code, stderr); the verdict functions are called directly for the cases.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { limits, machineSection, weightOf, live, STALE_AGENT_MS, MAX_AGENT_MS } from '../scripts/lib/machine.mjs'
import { loadRoles } from '../scripts/lib/roles.mjs'
import { heavyCommands } from '../scripts/lib/heavy-match.mjs'
import { verdict as dispatch, apply, resets } from '../scripts/agent-slots.mjs'
import { verdict as bash } from '../scripts/heavy-command.mjs'

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)).replace(/\\/g, '/')
const GB = 2 ** 30
const lim = (o = {}) => limits({ cpuCount: 8, memBytes: 16 * GB, env: {}, ...o })
const desc = (description) => ({ tool_name: 'Agent', tool_use_id: 'tu', tool_input: { description, prompt: 'x' } })
const entry = (weight, at, extra = {}) => ({ id: `t${at}`, agent_id: null, description: `${weight}: x`, weight, at, ...extra })

test('limits: this machine (8 cpus, 16 GB) gets 2 slots, 3 heavy agents, 10 light; fewer cpus or memory, fewer slots', () => {
  assert.deepEqual([lim().heavy_slots, lim().heavy_agents, lim().light_agents], [2, 3, 10])
  assert.equal(lim({ cpuCount: 4 }).heavy_slots, 1)
  assert.equal(lim({ cpuCount: 2 }).heavy_slots, 1)
  assert.equal(lim({ cpuCount: 32, memBytes: 8 * GB }).heavy_slots, 1)
  assert.equal(lim({ cpuCount: 16, memBytes: 64 * GB }).heavy_slots, 4)
  assert.equal(lim({ cpuCount: 16, memBytes: 64 * GB }).heavy_agents, 5)
})

test('limits: the project config wins over the defaults, the environment over both, and junk is ignored', () => {
  const config = machineSection('# x\n\n## machine\nheavy_slots: 3\n- `heavy_agents`: `6`\nlight_agents: lots\nheavy_commands: pytest, make test\n\n## next\nheavy_slots: 9\n')
  assert.deepEqual(config, { heavy_slots: '3', heavy_agents: '6', light_agents: 'lots', heavy_commands: 'pytest, make test' })
  const l = lim({ config })
  assert.deepEqual([l.heavy_slots, l.heavy_agents, l.light_agents], [3, 6, 10])
  assert.deepEqual(l.heavy_commands, ['pytest', 'make test'])
  assert.equal(lim({ config, env: { BATON_HEAVY_SLOTS: '1' } }).heavy_slots, 1)
  assert.equal(lim({ config: { heavy_slots: '0' } }).heavy_slots, 2)
})

test('weightOf: builders, fixers and mechanical are heavy; readers, reviewers and keys the table lacks are light', () => {
  const roles = loadRoles()
  for (const r of ['builder', 'fix', 'mechanical']) assert.equal(weightOf(`${r}: w1 s01`, roles), 'heavy', r)
  for (const r of ['critical-read', 'review-new-logic', 'review-small', 'walk', 'author', 'checker', 'cold-read', 'retro', 'whatever', 'note']) assert.equal(weightOf(`${r}: w1`, roles), 'light', r)
  assert.equal(weightOf('', roles), 'light')
  for (const [role, v] of Object.entries(roles.roles)) assert.ok(['heavy', 'light'].includes(v.local), `${role} has no local weight`)
})

// ---- the dispatch cap

test('dispatch: under the cap passes and records; at the cap refuses, naming the running agents of that weight only', () => {
  const now = 10_000_000
  const heavy = [entry('heavy', now - 60000, { description: 'builder: w1 s01' }), entry('heavy', now - 120000, { description: 'fix: w1 s02 round 2' })]
  const under = dispatch(desc('builder: w1 s03'), { epic: true, running: heavy, lim: lim(), now })
  assert.equal(under.block, false)
  assert.deepEqual([under.entry.weight, under.entry.description, under.entry.id], ['heavy', 'builder: w1 s03', 'tu'])
  const at = dispatch(desc('builder: w1 s03'), { epic: true, running: [...heavy, entry('heavy', now - 1000, { description: 'builder: w1 s04' })], lim: lim(), now })
  assert.equal(at.block, true)
  assert.match(at.reason, /3 heavy agents are running and the cap is 3/)
  assert.match(at.reason, /builder: w1 s01 \(1 min\); fix: w1 s02 round 2 \(2 min\); builder: w1 s04/)
  assert.match(at.reason, /Wait for a handback/)
  const light = Array.from({ length: 9 }, (_, i) => entry('light', now - i))
  assert.equal(dispatch(desc('review-small: w1 s01'), { epic: true, running: [...heavy, ...heavy, ...light], lim: lim(), now }).block, false, 'heavy agents do not count against light')
  assert.equal(dispatch(desc('review-small: w1 s01'), { epic: true, running: [...light, entry('light', now)], lim: lim(), now }).block, true)
  assert.equal(dispatch(desc('builder: w1 s01'), { epic: true, running: light.concat(light), lim: lim(), now }).block, false, 'light agents do not count against heavy')
})

test('dispatch: outside an epic, with BATON_MACHINE=0, or for any tool but Agent, nothing is refused or recorded', () => {
  const full = Array.from({ length: 12 }, (_, i) => entry('heavy', i))
  assert.deepEqual(dispatch(desc('builder: x'), { epic: false, running: full, lim: lim() }), { block: false })
  assert.deepEqual(dispatch(desc('builder: x'), { epic: true, env: { BATON_MACHINE: '0' }, running: full, lim: lim() }), { block: false })
  assert.deepEqual(dispatch({ tool_name: 'Bash', tool_input: {} }, { epic: true, running: full, lim: lim() }), { block: false })
})

test('stale entries are dropped: 90 minutes without a transcript write, 6 hours in all; a live transcript keeps its entry', () => {
  const now = 100 * 60 * 60 * 1000
  const fresh = entry('heavy', now - 1000)
  const quiet = entry('heavy', now - STALE_AGENT_MS - 1, { agent_id: 'q' })
  const writing = entry('heavy', now - 3 * 60 * 60 * 1000, { agent_id: 'w' })
  const ancient = entry('heavy', now - MAX_AGENT_MS - 1, { agent_id: 'a' })
  const mtimes = { [join('d', 'subagents', 'agent-q.jsonl')]: now - STALE_AGENT_MS - 5, [join('d', 'subagents', 'agent-w.jsonl')]: now - 60000, [join('d', 'subagents', 'agent-a.jsonl')]: now - 1000 }
  const kept = live([fresh, quiet, writing, ancient], now, 'd', (p) => mtimes[p] ?? null)
  assert.deepEqual(kept, [fresh, writing])
  const full = [entry('heavy', now - STALE_AGENT_MS - 1), entry('heavy', now - STALE_AGENT_MS - 2), entry('heavy', now - STALE_AGENT_MS - 3)]
  assert.equal(dispatch(desc('builder: x'), { epic: true, running: live(full, now, null), lim: lim(), now }).block, false)
})

test('hooks bind the id, free the entry on stop (by id, else by description), and a restart resets', () => {
  const a = entry('heavy', 1, { id: 'tu1', description: 'builder: s1' })
  const b = entry('heavy', 2, { id: 'tu2', description: 'builder: s2' })
  const bound = apply('bound', { tool_use_id: 'tu1', tool_response: { status: 'async_launched', agentId: 'A1' } }, [a, b])
  assert.equal(bound[0].agent_id, 'A1')
  assert.equal(apply('bound', { tool_use_id: 'tu2', tool_response: { status: 'completed', agentId: 'B' } }, bound).length, 1, 'a foreground agent has finished')
  assert.deepEqual(apply('stop', { agent_id: 'A1' }, bound).map((e) => e.id), ['tu2'])
  assert.equal(apply('stop', { agent_id: 'nobody' }, bound).length, 2)
  const dir = mkdtempSync(join(tmpdir(), 'mach-'))
  writeFileSync(join(dir, 'agent-B.jsonl'), '')
  writeFileSync(join(dir, 'agent-B.meta.json'), JSON.stringify({ description: 'builder: s2' }))
  assert.deepEqual(apply('stop', { agent_id: 'B', agent_transcript_path: join(dir, 'agent-B.jsonl') }, bound).map((e) => e.id), ['tu1'])
  assert.equal(resets({ source: 'startup' }) && resets({ source: 'resume' }), true)
  assert.equal(resets({ source: 'compact' }) || resets({ source: 'clear' }), false)
})

// ---- the hooks, run as the harness runs them

function session() {
  const baton = mkdtempSync(join(tmpdir(), 'mach-'))
  const dir = join(baton, 'sess')
  mkdirSync(join(dir, 'subagents'), { recursive: true })
  const env = { ...process.env, BATON_HOME: baton, BATON_EPIC: '1', BATON_MACHINE: '', BATON_PROJECT_CONFIG: '', BATON_HEAVY_SLOTS: '2', BATON_HEAVY_AGENTS: '3', BATON_LIGHT_AGENTS: '10' }
  const run = (mode, input, e = {}) => {
    const r = spawnSync(process.execPath, [script('agent-slots.mjs'), mode], {
      input: JSON.stringify({ session_id: 's1', transcript_path: join(baton, 'sess.jsonl'), cwd: baton, tool_name: 'Agent', ...input }), encoding: 'utf8', env: { ...env, ...e },
    })
    return { status: r.status, stderr: r.stderr }
  }
  const state = () => JSON.parse(readFileSync(join(dir, 'baton-agents.json'), 'utf8')).agents
  return { baton, dir, run, state }
}
const launch = (id, description) => ({ tool_use_id: id, tool_input: { description, prompt: 'x', model: 'sonnet' } })

test('hooks end to end: the fourth builder is refused, a handback frees a place, a restart frees them all', () => {
  const { run, state } = session()
  for (const n of [1, 2, 3]) assert.equal(run('check', launch(`u${n}`, `builder: s${n}`)).status, 0)
  const refused = run('check', launch('u4', 'fix: s4'))
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /3 heavy agents are running/)
  assert.match(refused.stderr, /builder: s1.*builder: s2.*builder: s3/)
  assert.equal(state().length, 3, 'a refused dispatch is not recorded')
  assert.equal(run('check', launch('r1', 'review-small: s1')).status, 0, 'a reviewer is light')
  run('bound', { tool_use_id: 'u1', tool_response: { status: 'async_launched', agentId: 'A1' } })
  assert.equal(run('stop', { tool_name: undefined, agent_id: 'A1' }).status, 0)
  assert.equal(run('check', launch('u4', 'fix: s4')).status, 0)
  assert.equal(run('check', launch('u5', 'fix: s5')).status, 2)
  run('reset', { source: 'compact' })
  assert.equal(state().length, 4)
  run('reset', { source: 'resume' })
  assert.equal(state().length, 0)
  assert.equal(run('check', launch('u5', 'fix: s5')).status, 0)
})

test('hooks end to end: outside an epic or with BATON_MACHINE=0 nothing is refused or recorded; a dispatch with no model is left to require-model', () => {
  const { run, state, dir } = session()
  for (const n of [1, 2, 3, 4]) assert.equal(run('check', launch(`u${n}`, `builder: s${n}`), { BATON_EPIC: '' }).status, 0)
  assert.equal(existsSync(join(dir, 'baton-agents.json')), false)
  for (const n of [1, 2, 3, 4]) assert.equal(run('check', launch(`u${n}`, `builder: s${n}`), { BATON_MACHINE: '0' }).status, 0)
  assert.equal(existsSync(join(dir, 'baton-agents.json')), false)
  assert.equal(run('check', { tool_use_id: 'x', tool_input: { description: 'builder: s9', prompt: 'x' } }).status, 0)
  assert.equal(existsSync(join(dir, 'baton-agents.json')), false, 'an unnamed model is refused by require-model, so it is not counted here')
  assert.equal(run('check', launch('u1', 'builder: s1')).status, 0)
  assert.equal(state().length, 1)
})

test('hooks end to end: a stale entry in the file does not count, and parallel dispatches are counted once each', () => {
  const { run, state, dir } = session()
  const old = Date.now() - 2 * STALE_AGENT_MS
  writeFileSync(join(dir, 'baton-agents.json'), JSON.stringify({ agents: [1, 2, 3].map((n) => entry('heavy', old, { id: `o${n}` })) }))
  assert.equal(run('check', launch('u1', 'builder: s1')).status, 0)
  assert.equal(state().length, 1)
})

test('hooks end to end: a hook given no JSON lets the call through', () => {
  const r = spawnSync(process.execPath, [script('agent-slots.mjs'), 'check'], { input: 'not json', encoding: 'utf8' })
  assert.equal(r.status, 0)
})

// ---- the command matcher and the Bash hook

const SH = '/p/scripts/heavy.sh'
const heavy = (c, patterns = limits({ env: {} }).heavy_commands) => heavyCommands(c, patterns, SH)

test('matcher: every default pattern is caught and rewritten', () => {
  const cases = {
    'pytest': 'bash "/p/scripts/heavy.sh" pytest',
    'python3 -m pytest -n auto --dist loadgroup': 'bash "/p/scripts/heavy.sh" python3 -m pytest -n auto --dist loadgroup',
    'node --test test/*.test.mjs': 'bash "/p/scripts/heavy.sh" node --test test/*.test.mjs',
    'npm test': 'bash "/p/scripts/heavy.sh" npm test',
    'npm run test:unit': 'bash "/p/scripts/heavy.sh" npm run test:unit',
    'npm run lint': 'bash "/p/scripts/heavy.sh" npm run lint',
    'npm run build': 'bash "/p/scripts/heavy.sh" npm run build',
    'npx vitest run': 'bash "/p/scripts/heavy.sh" npx vitest run',
    'vitest': 'bash "/p/scripts/heavy.sh" vitest',
    'npx tsc -b': 'bash "/p/scripts/heavy.sh" npx tsc -b',
    'tsc -b --noEmit': 'bash "/p/scripts/heavy.sh" tsc -b --noEmit',
    'cargo test': 'bash "/p/scripts/heavy.sh" cargo test',
    'cargo nextest run': 'bash "/p/scripts/heavy.sh" cargo nextest run',
    'cargo build --release': 'bash "/p/scripts/heavy.sh" cargo build --release',
    'docker run --rm img': 'bash "/p/scripts/heavy.sh" docker run --rm img',
    'npx playwright test': 'bash "/p/scripts/heavy.sh" npx playwright test',
  }
  for (const [c, want] of Object.entries(cases)) {
    const r = heavy(c)
    assert.equal(r.found.length, 1, c)
    assert.equal(r.rewritten, want, c)
  }
})

test('matcher: a runner behind uv run, env assignments, time or a cd is caught, and the rewrite puts heavy.sh where it can run', () => {
  assert.equal(heavy('uv run --python 3.12 --with pyshacl==0.30.1 --with rdflib python -m pytest -k x').rewritten,
    'bash "/p/scripts/heavy.sh" uv run --python 3.12 --with pyshacl==0.30.1 --with rdflib python -m pytest -k x')
  assert.equal(heavy('CI=1 FOO="a b" pytest').rewritten, 'CI=1 FOO="a b" bash "/p/scripts/heavy.sh" pytest')
  assert.equal(heavy('time npm test').rewritten, 'time bash "/p/scripts/heavy.sh" npm test')
  assert.equal(heavy('cd pkg && npm run lint 2>&1 | tail -5').rewritten, 'cd pkg && bash "/p/scripts/heavy.sh" npm run lint 2>&1 | tail -5')
  const two = heavy('npm run lint; git status && pytest -q')
  assert.equal(two.found.length, 2)
  assert.equal(two.rewritten, 'bash "/p/scripts/heavy.sh" npm run lint; git status && bash "/p/scripts/heavy.sh" pytest -q')
})

test('matcher: a command already through heavy.sh passes, but only that command of a line', () => {
  for (const c of ['bash /p/scripts/heavy.sh pytest', 'bash "C:/x/baton/scripts/heavy.sh" npm test', 'heavy.sh pytest', './scripts/heavy.sh node --test', 'CI=1 bash /p/scripts/heavy.sh pytest -n auto', 'cd a && bash /p/scripts/heavy.sh npm run lint']) {
    assert.equal(heavy(c).found.length, 0, c)
  }
  const half = heavy('bash /p/scripts/heavy.sh pytest && npm test')
  assert.equal(half.found.length, 1)
  assert.equal(half.rewritten, 'bash /p/scripts/heavy.sh pytest && bash "/p/scripts/heavy.sh" npm test')
})

test('matcher: a command that only names a runner is not one', () => {
  for (const c of [
    'grep pytest requirements.txt', 'grep -rn "npm test" docs', 'echo "run pytest and npm run lint"', 'git commit -m "fix pytest and vitest"',
    'cat tests/pytest.ini', 'ls node_modules/.bin/vitest', 'gh pr comment 3 --body "npm run build is slow"', 'pip install pytest', 'npm install',
    'npm run test-helpers-doc', 'node scripts/ledger.mjs x', 'git log --grep="cargo test"', 'docker ps', 'cargo fmt', 'rg "docker run" .', "sed -n 1,5p 'tests/pytest.md'",
  ]) {
    assert.equal(heavy(c).found.length, 0, c)
  }
})

test('matcher: the project replaces the list with machine.heavy_commands', () => {
  assert.equal(heavy('make check', ['make check']).found.length, 1)
  assert.equal(heavy('pytest', ['make check']).found.length, 0)
  assert.equal(heavy('cargo clippy', ['cargo (clippy|doc)']).found.length, 1)
})

const sh = (command, o = {}) => bash({ tool_name: 'Bash', tool_input: { command } }, { epic: true, heavySh: SH, ...o })

test('bash hook: a heavy command is refused with the exact command to run; a wrapped or light one passes', () => {
  const r = sh('cd repo && pytest -n auto')
  assert.equal(r.block, true)
  assert.match(r.reason, /pytest is a heavy local command/)
  assert.ok(r.reason.endsWith('\ncd repo && bash "/p/scripts/heavy.sh" pytest -n auto'), r.reason)
  assert.equal(sh('bash /p/scripts/heavy.sh pytest').block, false)
  assert.equal(sh('grep pytest x').block, false)
  assert.equal(bash({ tool_name: 'PowerShell', tool_input: { command: 'npm test' } }, { epic: true, heavySh: SH }).block, true)
  assert.equal(bash({ tool_name: 'Read', tool_input: { command: 'npm test' } }, { epic: true, heavySh: SH }).block, false)
})

test('bash hook: outside an epic, with BATON_MACHINE=0, and for a command that is not a string, nothing is refused', () => {
  assert.equal(sh('pytest', { epic: false }).block, false)
  assert.equal(sh('pytest', { env: { BATON_MACHINE: '0' } }).block, false)
  assert.equal(bash({ tool_name: 'Bash', tool_input: {} }, { epic: true }).block, false)
})

test('bash hook, as run: exit 2 with the rewrite on stderr, 0 for the wrapped form, 0 outside an epic', () => {
  const baton = mkdtempSync(join(tmpdir(), 'mach-'))
  const run = (command, env = {}) => spawnSync(process.execPath, [script('heavy-command.mjs')], {
    input: JSON.stringify({ session_id: 's1', cwd: baton, tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8',
    env: { ...process.env, BATON_HOME: baton, BATON_EPIC: '1', BATON_MACHINE: '', BATON_PROJECT_CONFIG: '', ...env },
  })
  const blocked = run('npm run lint')
  assert.equal(blocked.status, 2)
  assert.match(blocked.stderr, /bash ".*scripts\/heavy\.sh" npm run lint/)
  assert.equal(run(blocked.stderr.split('\n')[1]).status, 0, 'the command it gives is let through')
  assert.equal(run('npm run lint', { BATON_EPIC: '' }).status, 0)
  assert.equal(run('npm run lint', { BATON_MACHINE: '0' }).status, 0)
  const config = join(baton, 'project.md')
  writeFileSync(config, '## machine\nheavy_commands: make check\n')
  assert.equal(run('npm run lint', { BATON_PROJECT_CONFIG: config }).status, 0)
  assert.equal(run('make check', { BATON_PROJECT_CONFIG: config }).status, 2)
  assert.equal(spawnSync(process.execPath, [script('heavy-command.mjs')], { input: 'garbage', encoding: 'utf8' }).status, 0)
})

// ---- heavy.sh

const BASH = process.env.BATON_TEST_BASH || 'bash'
const haveBash = spawnSync(BASH, ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok'
const heavySh = (heavyDir, args, env = {}, opts = {}) => spawnSync(BASH, [script('heavy.sh'), ...args], {
  encoding: 'utf8', env: { ...process.env, BATON_HEAVY_DIR: heavyDir.replace(/\\/g, '/'), BATON_HEAVY_SLOTS: '2', BATON_MACHINE: '', BATON_HEAVY_HELD: '', BATON_HEAVY_POLL: '0.2', PYTEST_XDIST_AUTO_NUM_WORKERS: '', ...env }, ...opts,
})
const deadPid = () => spawnSync(BASH, ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()
const bashIt = haveBash ? test : test.skip

bashIt('heavy.sh: runs the command with its exit code, sizes pytest-xdist to its share of the cpus, and frees its slot', () => {
  const d = mkdtempSync(join(tmpdir(), 'heavy-'))
  const r = heavySh(d, ['bash', '-c', 'echo "workers=$PYTEST_XDIST_AUTO_NUM_WORKERS"; ls "$BATON_HEAVY_DIR"; exit 7'])
  assert.equal(r.status, 7)
  const cpus = Number(JSON.parse(spawnSync(process.execPath, [script('machine.mjs'), '--json'], { encoding: 'utf8', env: { ...process.env, BATON_HEAVY_SLOTS: '2' } }).stdout).cpus)
  assert.match(r.stdout, new RegExp(`workers=${Math.max(1, Math.floor(cpus / 2))}\\b`))
  assert.match(r.stdout, /slot-1/)
  assert.deepEqual(readdirSync(d), [], 'the slot is released')
  assert.equal(heavySh(d, ['bash', '-c', 'echo "workers=$PYTEST_XDIST_AUTO_NUM_WORKERS"'], { PYTEST_XDIST_AUTO_NUM_WORKERS: '5' }).stdout.trim(), 'workers=5')
})

bashIt('heavy.sh: a slot whose pid is dead is reclaimed without waiting', () => {
  const d = mkdtempSync(join(tmpdir(), 'heavy-'))
  const dead = deadPid()
  for (const n of [1, 2]) { mkdirSync(join(d, `slot-${n}`)); writeFileSync(join(d, `slot-${n}`, 'pid'), dead) }
  const r = heavySh(d, ['bash', '-c', 'cat "$BATON_HEAVY_DIR"/slot-1/pid'])
  assert.equal(r.status, 0)
  assert.doesNotMatch(r.stderr, /waiting/, 'it did not wait for a dead owner')
  assert.notEqual(r.stdout.trim(), dead, 'slot 1 was taken over by this run')
  assert.deepEqual(readdirSync(d).filter((n) => n.endsWith('.reclaim')), [])
})

bashIt('heavy.sh: a slot with no pid yet is an owner still writing it, and is taken over once it is a minute old', async () => {
  const e = mkdtempSync(join(tmpdir(), 'heavy-'))
  mkdirSync(join(e, 'slot-1'))
  const child = spawn(BASH, [script('heavy.sh'), 'echo', 'ran'], { env: { ...process.env, BATON_HEAVY_DIR: e.replace(/\\/g, '/'), BATON_HEAVY_SLOTS: '1', BATON_MACHINE: '', BATON_HEAVY_HELD: '', BATON_HEAVY_POLL: '0.2' } })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  for (let n = 0; n < 50 && !/waiting/.test(err); n++) await new Promise((r) => setTimeout(r, 100))
  assert.match(err, /all 1 heavy slots are taken/)
  assert.equal(out, '', 'it has not run while the slot may still be being written')
  const old = new Date(Date.now() - 5 * 60 * 1000)
  utimesSync(join(e, 'slot-1'), old, old)
  const code = await new Promise((r) => child.on('close', r))
  assert.equal(code, 0)
  assert.equal(out.trim(), 'ran')
})

bashIt('heavy.sh: with every slot held by a live process it says so once and waits for a release', async () => {
  const d = mkdtempSync(join(tmpdir(), 'heavy-'))
  const holder = spawn(BASH, [script('heavy.sh'), 'sleep', '2'], { env: { ...process.env, BATON_HEAVY_DIR: d.replace(/\\/g, '/'), BATON_HEAVY_SLOTS: '1', BATON_MACHINE: '', BATON_HEAVY_HELD: '', BATON_HEAVY_POLL: '0.2' }, stdio: 'ignore' })
  for (let i = 0; i < 50 && !existsSync(join(d, 'slot-1', 'pid')); i++) await new Promise((r) => setTimeout(r, 100))
  const t = Date.now()
  const r = heavySh(d, ['echo', 'third'], { BATON_HEAVY_SLOTS: '1' })
  assert.equal(r.stdout.trim(), 'third')
  assert.equal(r.stderr.match(/waiting/g).length, 1)
  assert.ok(Date.now() - t > 700, 'it waited for the holder')
  await new Promise((r) => holder.on('exit', r))
  assert.deepEqual(readdirSync(d), [])
})

bashIt('heavy.sh: a signal frees the slot and stops the command; BATON_MACHINE=0 and a nested call run the command at once', () => {
  const d = mkdtempSync(join(tmpdir(), 'heavy-')).replace(/\\/g, '/')
  const r = spawnSync(BASH, ['-c', `bash "${script('heavy.sh')}" sleep 30 & p=$!; sleep 1; kill -TERM $p; wait $p; echo "rc=$?"; ls "$BATON_HEAVY_DIR" | wc -l`], {
    encoding: 'utf8', timeout: 15000, env: { ...process.env, BATON_HEAVY_DIR: d, BATON_HEAVY_SLOTS: '1', BATON_MACHINE: '', BATON_HEAVY_HELD: '' },
  })
  assert.match(r.stdout, /rc=143\s+0/, r.stdout + r.stderr)
  assert.equal(heavySh(d, ['echo', 'off'], { BATON_MACHINE: '0' }).stdout.trim(), 'off')
  assert.equal(heavySh(d, ['echo', 'nested'], { BATON_HEAVY_HELD: '1', BATON_HEAVY_SLOTS: '1' }).stdout.trim(), 'nested')
  assert.equal(heavySh(d, []).status, 2)
})
