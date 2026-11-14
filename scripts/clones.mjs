#!/usr/bin/env node
// The main clones beside this repository, as the gate reports them after a merge:
//
//   node clones.mjs [--pull <owner/repo>]
//
// Names every main clone in the clones folder (a sibling checkout that tests and builds read as it stands on disk) that is
// not on its default branch, or on its home branch where its git config sets `baton.homeBranch`. With --pull, fast-forwards
// the clone of <owner/repo> (the folder of that name, or the one whose remote is it), when it is on its default branch, so
// the merged code is what its siblings read. The clones folder is `BATON_CLONES_ROOT`, else the project config's `clones`
// section (`root:`), else the one the dispatch hook last saved, else the folder holding the main clone of the repository the
// working directory is in; when none is found it says so. Prints only; exit 0.

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { run as realRun, isMain } from './lib/exec.mjs'
import { defaultBranch, homeBranch } from './guard-hook.mjs'
import { projectConfigPath, keyValueSection, limitsFilePath } from './lib/machine.mjs'

const slash = (p) => String(p).replace(/\\/g, '/').replace(/\/$/, '')

// The folder that holds the main clone of the repository `cwd` is in, or null outside one.
export function clonesRoot(cwd, run = realRun) {
  const r = run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!r.ok || !r.out) return null
  return posix.dirname(posix.dirname(slash(r.out)))
}

// The clones folder the project names, else the repository the working directory is in.
export function findRoot(cwd, { env = process.env, run = realRun } = {}) {
  if (env.BATON_CLONES_ROOT) return slash(env.BATON_CLONES_ROOT)
  try {
    const config = projectConfigPath(env, cwd)
    const root = config && keyValueSection(readFileSync(config, 'utf8'), 'clones').root
    if (root) return slash(root)
  } catch {}
  try {
    const saved = JSON.parse(readFileSync(limitsFilePath(env), 'utf8')).clones_root
    if (saved) return slash(saved)
  } catch {}
  return clonesRoot(cwd, run)
}

// Each direct subfolder with a .git directory (a linked worktree has a .git file): where it is and what it is on. A clone
// meant to sit on another branch says so in its git config (baton.homeBranch), and that branch is its `base`.
export function mainClones(root, run = realRun) {
  const out = []
  for (const name of readdirSync(root).sort()) {
    const dir = `${slash(root)}/${name}`
    try { if (!statSync(join(dir, '.git')).isDirectory()) continue } catch { continue }
    const branch = run('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'])
    const sha = branch.ok ? null : run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']).out
    const home = homeBranch(dir, run)
    const def = defaultBranch(dir, run)
    out.push({ name, dir, branch: branch.ok ? branch.out : null, sha, base: home ?? def, home, def })
  }
  return out
}

export function report(cwd, { pull = null, run = realRun, env = process.env } = {}) {
  const root = findRoot(cwd, { env, run })
  if (!root || !existsSync(root)) return [`clones: cannot find the folder that holds the clones (set BATON_CLONES_ROOT, or a \`clones\` section with \`root:\` in the project config, or run from inside a repository): no clone checked, none pulled`]
  const lines = []
  const clones = mainClones(root, run)
  for (const c of clones) {
    if (c.branch === c.base) continue
    lines.push(c.branch ? `main clone ${c.name} is on ${c.branch}, not ${c.base}: ${c.dir}` : `main clone ${c.name} is detached at ${c.sha}, not on ${c.base}: ${c.dir}`)
  }
  if (pull) {
    const [owner, name] = pull.split('/')
    const remoteOf = new RegExp(`[:/]${owner}/${name}(\\.git)?/?$`, 'i')
    let found = false
    for (const c of clones) {
      const remotes = run('git', ['-C', c.dir, 'remote', '-v']).out.split(/\r?\n/).map((l) => l.split(/\s+/)).filter((p) => p[1] && remoteOf.test(slash(p[1])))
      if (!remotes.length && c.name !== name) continue
      found = true
      if (c.home && c.home !== c.def) { lines.push(`${c.name}: not pulled, it sits on its home branch ${c.home}`); continue }
      if (c.branch !== c.base) { lines.push(`${c.name}: not pulled, it is on ${c.branch ?? `a detached ${c.sha}`}`); continue }
      const r = run('git', ['-C', c.dir, 'pull', '--ff-only', '-q', remotes[0]?.[0] ?? 'origin', c.base])
      const head = run('git', ['-C', c.dir, 'rev-parse', '--short', 'HEAD']).out
      lines.push(r.ok ? `${c.name}: pulled ${c.base} to ${head}` : `${c.name}: pull --ff-only failed: ${r.err.split('\n')[0]}`)
    }
    if (!found) lines.push(`clones: no clone of ${pull} under ${root}: nothing pulled`)
  }
  return lines
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const pull = args.includes('--pull') ? args[args.indexOf('--pull') + 1] : null
  try { for (const line of report(process.cwd(), { pull })) console.log(line) } catch (e) { console.error(`clones.mjs: ${e.message}`) }
}
