#!/usr/bin/env node
// The main clones beside this repository, as the gate reports them after a merge:
//
//   node clones.mjs [--pull <owner/repo>]
//
// Names every main clone in the folder that holds this repository's main clone (a sibling checkout that tests and
// builds read as it stands on disk) that is not on its default branch. With --pull, fast-forwards the clone whose remote
// is <owner/repo>, when it is on its default branch, so the merged code is what its siblings read. Prints only; exit 0.

import { readdirSync, existsSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { run as realRun, isMain } from './lib/exec.mjs'
import { defaultBranch } from './guard-hook.mjs'

const slash = (p) => String(p).replace(/\\/g, '/').replace(/\/$/, '')

// The folder that holds the main clone of the repository `cwd` is in, or null outside one.
export function clonesRoot(cwd, run = realRun) {
  const r = run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!r.ok || !r.out) return null
  return posix.dirname(posix.dirname(slash(r.out)))
}

// Each direct subfolder with a .git directory (a linked worktree has a .git file): where it is and what it is on.
export function mainClones(root, run = realRun) {
  const out = []
  for (const name of readdirSync(root).sort()) {
    const dir = `${slash(root)}/${name}`
    try { if (!statSync(join(dir, '.git')).isDirectory()) continue } catch { continue }
    const branch = run('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'])
    const sha = branch.ok ? null : run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']).out
    out.push({ name, dir, branch: branch.ok ? branch.out : null, sha, base: defaultBranch(dir, run) })
  }
  return out
}

export function report(cwd, { pull = null, run = realRun } = {}) {
  const root = clonesRoot(cwd, run)
  if (!root || !existsSync(root)) return []
  const lines = []
  const clones = mainClones(root, run)
  for (const c of clones) {
    if (c.branch === c.base) continue
    lines.push(c.branch ? `main clone ${c.name} is on ${c.branch}, not ${c.base}: ${c.dir}` : `main clone ${c.name} is detached at ${c.sha}, not on ${c.base}: ${c.dir}`)
  }
  if (pull) {
    const [owner, name] = pull.split('/')
    const remoteOf = new RegExp(`[:/]${owner}/${name}(\\.git)?/?$`, 'i')
    for (const c of clones) {
      const remotes = run('git', ['-C', c.dir, 'remote', '-v']).out.split(/\r?\n/).map((l) => l.split(/\s+/)).filter((p) => p[1] && remoteOf.test(slash(p[1])))
      if (!remotes.length) continue
      if (c.branch !== c.base) { lines.push(`${c.name}: not pulled, it is on ${c.branch ?? `a detached ${c.sha}`}`); continue }
      const r = run('git', ['-C', c.dir, 'pull', '--ff-only', '-q', remotes[0][0], c.base])
      const head = run('git', ['-C', c.dir, 'rev-parse', '--short', 'HEAD']).out
      lines.push(r.ok ? `${c.name}: pulled ${c.base} to ${head}` : `${c.name}: pull --ff-only failed: ${r.err.split('\n')[0]}`)
    }
  }
  return lines
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const pull = args.includes('--pull') ? args[args.indexOf('--pull') + 1] : null
  try { for (const line of report(process.cwd(), { pull })) console.log(line) } catch (e) { console.error(`clones.mjs: ${e.message}`) }
}
