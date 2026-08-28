#!/usr/bin/env node
// Puts the delivery on its work branch, or refuses and says why.
//
// Every branch of this has one right answer, which is why it is code. Getting
// it wrong is expensive and quiet: fork off the base when the branch already
// exists on origin and the delivery silently loses everything the last attempt
// pushed, then opens a second PR for the same issue.
//
// Exit codes are the contract:
//   0  ready      on the work branch, reconciled against origin
//   2  preflight  not a repo, fetch failed, integration branch absent, bad args
//   3  dirty      uncommitted changes a switch would drag onto the delivery
//   4  diverged   local and origin both moved: two attempts ran, pick neither

import { spawnSync } from 'node:child_process'
import { appendRun } from './lib/runlog.mjs'

const EXIT = { READY: 0, PREFLIGHT: 2, DIRTY: 3, DIVERGED: 4 }

function git(args, cwd) {
  const r = spawnSync('git', args, { encoding: 'utf8', shell: false, cwd, maxBuffer: 16 * 1024 * 1024 })
  if (r.error?.code === 'ENOENT') return { ok: false, code: null, out: '', err: 'git is not on PATH' }
  return { ok: !r.error && r.status === 0, code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

function parseArgs(argv) {
  const out = { work: null, base: null, dir: process.cwd(), worktree: null, json: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--work') out.work = argv[++i]
    else if (a === '--base') out.base = argv[++i]
    else if (a === '--dir') out.dir = argv[++i]
    else if (a === '--worktree') out.worktree = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--dry-run') out.dryRun = true
    else return { error: `unrecognised argument: ${a}` }
  }
  if (!out.work) return { error: 'missing --work <branch>' }
  if (!out.base) return { error: 'missing --base <branch>' }
  // A ref name reaches git as an argument, never a shell word, but a name that
  // looks like a flag or a path traversal is a mistake worth catching early.
  for (const [k, v] of [['--work', out.work], ['--base', out.base]]) {
    if (v.startsWith('-') || v.includes('..') || /\s/.test(v)) return { error: `${k} is not a plausible branch name: ${v}` }
  }
  return out
}

// origin/<work>...HEAD → "behind ahead". Exit 128 means origin has no such
// branch, which is not an error here: everything local is simply unpushed.
function reconcile(work, cwd) {
  const r = git(['rev-list', '--left-right', '--count', `origin/${work}...HEAD`], cwd)
  if (!r.ok) return { behind: 0, ahead: null, noUpstream: true }
  const [behind, ahead] = r.out.split(/\s+/).map(Number)
  return { behind, ahead, noUpstream: false }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.error) {
    console.error(`branch: ${opts.error}`)
    console.error('usage: branch.mjs --work <branch> --base <branch> [--dir <repo>] [--worktree <path>] [--json]')
    return EXIT.PREFLIGHT
  }

  const D = opts.dir
  const top = git(['rev-parse', '--show-toplevel'], D)
  if (!top.ok) return done(opts, { outcome: 'preflight', reason: `${D} is not a git repository`, detail: top.err }, EXIT.PREFLIGHT)

  const repo = (() => {
    const r = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8', cwd: D })
    return (r.stdout ?? '').trim() || null
  })()

  const fetched = git(['fetch', 'origin'], D)
  if (!fetched.ok) return done(opts, { repo, outcome: 'preflight', reason: 'git fetch origin failed', detail: fetched.err }, EXIT.PREFLIGHT)

  // The base must exist on origin. Everything downstream branches from it, and
  // a typo here creates a branch off nothing rather than failing.
  const baseOnOrigin = git(['ls-remote', '--heads', 'origin', opts.base], D)
  if (!baseOnOrigin.ok || !baseOnOrigin.out) {
    return done(opts, { repo, outcome: 'preflight', reason: `integration branch not on origin: ${opts.base}` }, EXIT.PREFLIGHT)
  }

  const localExists = git(['rev-parse', '--verify', '--quiet', `refs/heads/${opts.work}`], D).ok
  const remoteExists = Boolean(git(['ls-remote', '--heads', 'origin', opts.work], D).out)
  const state = { repo, work: opts.work, base: opts.base, localExists, remoteExists, worktree: opts.worktree }

  if (opts.dryRun) return done(opts, { ...state, outcome: 'preflight', reason: 'dry run: nothing was changed', plan: plan(state) }, EXIT.PREFLIGHT)

  let cwd = D
  let action

  if (opts.worktree) {
    // A worktree is its own checkout, so the main tree being dirty is not this
    // delivery's problem.
    const listed = git(['worktree', 'list', '--porcelain'], D).out
    const already = listed.split(/\r?\n/).some(l => l === `branch refs/heads/${opts.work}`)
    if (already) {
      const m = listed.match(new RegExp(`worktree (.+)\\r?\\n(?:HEAD [0-9a-f]+\\r?\\n)?branch refs/heads/${opts.work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
      cwd = m ? m[1] : opts.worktree
      action = 'reused existing worktree'
    } else if (remoteExists) {
      // --track off origin. Plain -b forks off the base and strips the delivery
      // of everything already pushed.
      const r = git(['worktree', 'add', '--track', '-b', opts.work, opts.worktree, `origin/${opts.work}`], D)
      if (!r.ok) return done(opts, { ...state, outcome: 'preflight', reason: 'git worktree add failed', detail: r.err }, EXIT.PREFLIGHT)
      cwd = opts.worktree; action = 'created worktree tracking origin'
    } else {
      const r = git(['worktree', 'add', '-b', opts.work, opts.worktree, `origin/${opts.base}`], D)
      if (!r.ok) return done(opts, { ...state, outcome: 'preflight', reason: 'git worktree add failed', detail: r.err }, EXIT.PREFLIGHT)
      cwd = opts.worktree; action = 'created worktree off the base'
    }
  } else {
    const dirty = git(['status', '--porcelain'], D).out
    if (dirty) {
      return done(opts, { ...state, outcome: 'dirty', reason: 'uncommitted changes; a switch would drag them onto the delivery', detail: dirty.split(/\r?\n/).slice(0, 20).join('\n') }, EXIT.DIRTY)
    }
    let r
    if (localExists) { r = git(['switch', opts.work], D); action = 'switched to local branch' }
    else if (remoteExists) { r = git(['switch', '--track', `origin/${opts.work}`], D); action = 'switched, tracking origin' }
    else { r = git(['switch', '-c', opts.work, `origin/${opts.base}`], D); action = 'created off the base' }
    if (!r.ok) return done(opts, { ...state, outcome: 'preflight', reason: 'git switch failed', detail: r.err }, EXIT.PREFLIGHT)
  }

  const rec = reconcile(opts.work, cwd)
  let reconciled = rec.noUpstream ? 'no upstream; everything local is unpushed' : 'already in sync'

  if (!rec.noUpstream) {
    if (rec.behind > 0 && rec.ahead > 0) {
      return done(opts, { ...state, cwd, action, ...rec, outcome: 'diverged',
        reason: `local and origin both moved (${rec.behind} behind, ${rec.ahead} ahead): two attempts ran and picking a side discards one` }, EXIT.DIVERGED)
    }
    if (rec.behind > 0) {
      const ff = git(['merge', '--ff-only', `origin/${opts.work}`], cwd)
      if (!ff.ok) return done(opts, { ...state, cwd, action, ...rec, outcome: 'preflight', reason: 'fast-forward failed', detail: ff.err }, EXIT.PREFLIGHT)
      reconciled = `fast-forwarded ${rec.behind}`
    } else if (rec.ahead > 0) {
      reconciled = `${rec.ahead} unpushed commit(s) kept`
    }
  }

  const head = git(['rev-parse', 'HEAD'], cwd).out
  return done(opts, { ...state, cwd, action, ...rec, head, reconciled, outcome: 'ready',
    reason: `on ${opts.work} — ${action}, ${reconciled}` }, EXIT.READY)
}

function plan(s) {
  if (s.worktree) return s.remoteExists ? 'worktree add --track off origin' : 'worktree add off the base'
  if (s.localExists) return 'switch to local branch'
  if (s.remoteExists) return 'switch --track origin'
  return 'switch -c off the base'
}

function done(opts, d, code) {
  const logged = opts.dryRun ? null : appendRun('branch', d.repo, { ...d, exit: code })
  if (opts.json) { console.log(JSON.stringify({ ...d, exit: code, runLog: logged }, null, 2)); return code }
  const L = [`branch: ${d.outcome.toUpperCase()} — ${d.reason}`]
  if (d.work) L.push(`  work ${d.work}  base ${d.base}  local=${d.localExists} origin=${d.remoteExists}`)
  if (d.cwd) L.push(`  cwd ${d.cwd}${d.head ? `  head ${d.head.slice(0, 8)}` : ''}`)
  if (d.plan) L.push(`  would: ${d.plan}`)
  if (d.detail) L.push('  ' + String(d.detail).split(/\r?\n/).join('\n  '))
  if (logged) L.push(`  logged: ${logged}`)
  console.log(L.join('\n'))
  return code
}

process.exitCode = main()
