// The machine's limits and heavy.sh, the recommended helper that holds local suites to the machine's slots. The dispatch
// cap is in dispatch-hook.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { limits, machineSection, weightOf } from '../scripts/lib/machine.mjs'
import { loadRoles } from '../scripts/lib/roles.mjs'

// heavy.sh and the hooks append events to the epic's log; these tests are not epics, and must not write to a real one.
process.env.BATON_EVENTS = '0'

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)).replace(/\\/g, '/')
const GB = 2 ** 30
const lim = (o = {}) => limits({ cpuCount: 8, memBytes: 16 * GB, env: {}, ...o })

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

bashIt('heavy.sh: a signal takes down the command and its grandchildren, and the slot is freed only once they are gone', () => {
  const d = mkdtempSync(join(tmpdir(), 'heavy-')).replace(/\\/g, '/')
  const marker = `${d}/survived.txt`
  const r = spawnSync(BASH, ['-c', `bash "${script('heavy.sh')}" bash -c '(sleep 3; echo survived > "${marker}") & wait' & p=$!; sleep 1.5; ls "$BATON_HEAVY_DIR" | grep -c slot-; kill -TERM $p; wait $p; echo "rc=$?"; ls "$BATON_HEAVY_DIR" | grep -c slot-; sleep 3.5; test -e "${marker}" && echo SURVIVED || echo gone`], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, BATON_HEAVY_DIR: d, BATON_HEAVY_SLOTS: '1', BATON_MACHINE: '', BATON_HEAVY_HELD: '', BATON_EVENTS: '0' },
  })
  assert.match(r.stdout, /^1\s+rc=143\s+0\s+gone\s*$/, r.stdout + r.stderr)
})

bashIt('heavy.sh: when the limits cannot be read it uses one slot and runs, never loops', () => {
  const d = mkdtempSync(join(tmpdir(), 'heavy-'))
  const r = heavySh(d, ['bash', '-c', 'echo ran'], { BATON_HEAVY_SLOTS: '', NODE_OPTIONS: '--import file:///no/such/module.mjs' }, { timeout: 15000 })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'ran')
  assert.deepEqual(readdirSync(d), [])
})

bashIt('heavy.sh: a reclaim lock left by a killed judge is taken over once it is a minute old, and the dead slot goes with it', () => {
  const d = mkdtempSync(join(tmpdir(), 'heavy-'))
  mkdirSync(join(d, 'slot-1')); writeFileSync(join(d, 'slot-1', 'pid'), deadPid())
  mkdirSync(join(d, 'slot-1.reclaim'))
  const old = new Date(Date.now() - 5 * 60 * 1000)
  utimesSync(join(d, 'slot-1.reclaim'), old, old)
  const r = heavySh(d, ['echo', 'ran'], { BATON_HEAVY_SLOTS: '1' }, { timeout: 15000 })
  assert.equal(r.stdout.trim(), 'ran')
  assert.doesNotMatch(r.stderr, /waiting/)
  assert.deepEqual(readdirSync(d), [])
})
