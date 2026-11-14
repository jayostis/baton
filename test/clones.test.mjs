// clones.mjs, which the gate runs after a merge: it names every main clone beside the repo that is not on its default
// branch, and fast-forwards the merged repo's own clone. Real repositories in Temp.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/clones.mjs', import.meta.url))
const fwd = (p) => p.replace(/\\/g, '/')
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env: gitEnv })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const commit = (dir, name) => { writeFileSync(join(dir, name), `${name}\n`); git(dir, 'add', name); git(dir, 'commit', '-m', name) }

// <root>/remotes/<name>.git bare origins; <root>/clones/<name> main clones; one linked worktree under clones/.worktrees.
function layout() {
  const root = fwd(realpathSync(mkdtempSync(join(tmpdir(), 'c-'))))
  mkdirSync(`${root}/remotes/owner`, { recursive: true })
  mkdirSync(`${root}/clones`)
  for (const name of ['alpha', 'beta', 'gamma']) {
    git(`${root}/remotes/owner`, 'init', '--bare', '-b', 'main', `${name}.git`)
    git(`${root}/clones`, 'clone', `${root}/remotes/owner/${name}.git`, name)
    commit(`${root}/clones/${name}`, 'one')
    git(`${root}/clones/${name}`, 'push', 'origin', 'main')
  }
  git(`${root}/clones/beta`, 'switch', '-c', 'side')
  git(`${root}/clones/gamma`, 'checkout', '--detach', 'HEAD')
  git(`${root}/clones/alpha`, 'worktree', 'add', `${root}/clones/.worktrees/alpha-x`, '-b', 'x')
  return root
}

// No ambient clones root or saved limits file: each test says where its clones are.
const run = (args, cwd, env = {}) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...gitEnv, BATON_CLONES_ROOT: '', BATON_PROJECT_CONFIG: '', BATON_MACHINE_FILE: join(tmpdir(), 'baton-no-such-limits.json'), ...env } })

test('clones: names each main clone beside this one that is off its default branch; a clone on main and a worktree are quiet', () => {
  const root = layout()
  const r = run([], `${root}/clones/.worktrees/alpha-x`)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /beta is on side, not main/)
  assert.match(r.stdout, /gamma is detached at [0-9a-f]{7,}, not on main/)
  assert.doesNotMatch(r.stdout, /alpha/)
  assert.equal(run([], `${root}/clones/alpha`).stdout, r.stdout, 'from the main clone itself, the same report')
  assert.equal(run([], root).status, 0, 'outside any repository: nothing to say, exit 0')
})

test('clones --pull <owner/repo>: fast-forwards the merged repo\'s clone when it is on its default branch, and says so', () => {
  const root = layout()
  const other = `${root}/other`
  git(root, 'clone', `${root}/remotes/owner/alpha.git`, 'other')
  commit(other, 'two')
  git(other, 'push', 'origin', 'main')
  const before = git(`${root}/clones/alpha`, 'rev-parse', 'HEAD')
  const r = run(['--pull', 'owner/alpha'], `${root}/clones/alpha`)
  assert.equal(r.status, 0, r.stderr)
  assert.notEqual(git(`${root}/clones/alpha`, 'rev-parse', 'HEAD'), before)
  assert.match(r.stdout, /alpha: pulled main to [0-9a-f]{7}/)
  const off = run(['--pull', 'owner/beta'], `${root}/clones/alpha`)
  assert.match(off.stdout, /beta: not pulled, it is on side/)
})

test('clones: from a folder that is no repository, the clones folder comes from BATON_CLONES_ROOT, the config\'s clones section or the saved limits file', () => {
  const root = layout()
  const away = mkdtempSync(join(tmpdir(), 'run-'))
  const lost = run(['--pull', 'owner/alpha'], away)
  assert.equal(lost.status, 0)
  assert.match(lost.stdout, /cannot find the folder that holds the clones/)
  const byEnv = run(['--pull', 'owner/alpha'], away, { BATON_CLONES_ROOT: `${root}/clones` })
  assert.match(byEnv.stdout, /beta is on side, not main/)
  assert.match(byEnv.stdout, /alpha: pulled main to [0-9a-f]{7}/)
  const config = join(away, 'project.md')
  writeFileSync(config, `# Project\n\n## clones\nroot: \`${root}/clones\`\n`)
  assert.match(run([], away, { BATON_PROJECT_CONFIG: config }).stdout, /beta is on side/)
  const limits = join(away, 'limits.json')
  writeFileSync(limits, JSON.stringify({ heavy_slots: 1, clones_root: `${root}/clones` }))
  assert.match(run([], away, { BATON_MACHINE_FILE: limits }).stdout, /beta is on side/)
  assert.match(run(['--pull', 'owner/nothing'], away, { BATON_CLONES_ROOT: `${root}/clones` }).stdout, /no clone of owner\/nothing under/)
})

test('clones: a clone whose git config names baton.homeBranch is home on it, and is not pulled', () => {
  const root = layout()
  git(`${root}/clones/beta`, 'config', 'baton.homeBranch', 'side')
  const r = run(['--pull', 'owner/beta'], `${root}/clones/alpha`)
  assert.doesNotMatch(r.stdout, /beta is on/)
  assert.match(r.stdout, /beta: not pulled, it sits on its home branch side/)
})
