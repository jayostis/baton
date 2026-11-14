#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell, in an epic only: refuses the shell commands that retros found cost rounds, so no
// agent has to have read a lesson for the rule to hold.
//
//   - a main clone moved off its default branch: `git switch <branch>`, `git checkout <branch|ref|-b|-|--detach>`, by the
//     working directory, `cd X &&` / `Set-Location X;` or `git -C X`. A main clone is a repository whose git dir is its
//     common dir, so not a linked worktree. `git checkout -- <path>`, `git checkout <ref> -- <path>`, `git restore` and a
//     return to the default branch pass. The refusal names the worktree to use.
//   - `git stash` (list and show pass), a forced push, `git rebase` (--abort and --continue pass).
//   - `gh pr|issue|run|workflow|release|label|cache` without -R, and `gh pr merge` at all: merges go through gate.sh.
//   - `npm ci` in a linked worktree.
//   - on Windows, `sed -i` and a heredoc written to a file: the Bash tool halves backslashes and files may be CRLF.
//
// Quoted text and heredoc bodies are not read as commands. Exit 0 lets the call through; exit 2 blocks it and its stderr
// goes back as the reason. Anything it cannot read (bad input, a directory that is not a repository) is let through.
// BATON_GUARD=0 turns it off.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { posix } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { inEpic } from './epic-mode.mjs'
import { run as realRun } from './lib/exec.mjs'
import { projectConfigPath, sectionCommand } from './lib/machine.mjs'

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'])
const WRAPPERS = new Set(['command', 'env', 'exec', 'nohup', 'sudo', 'time'])

// A path as a shell would resolve it, with forward slashes; a Git Bash path (/c/dev) is a Windows one on Windows.
export function toPath(p, base, platform = process.platform) {
  let s = String(p).replace(/\\/g, '/')
  if (s === '~' || s.startsWith('~/')) s = homedir().replace(/\\/g, '/') + s.slice(1)
  const drive = /^\/([a-zA-Z])(\/|$)/.exec(s)
  if (platform === 'win32' && drive) s = `${drive[1].toUpperCase()}:/${s.slice(3)}`
  const absolute = s.startsWith('/') || /^[A-Za-z]:\//.test(s)
  return posix.normalize(absolute ? s : `${String(base).replace(/\\/g, '/')}/${s}`).replace(/(.)\/$/, '$1')
}

// The simple commands of a command line, each with its argv, the directory it runs in (following cd), its redirect targets
// and whether it reads a heredoc. Splits on && || ; | & ( ) and newlines outside quotes.
export function segments(command, cwd, platform = process.platform) {
  const text = String(command)
  const out = []
  let seg = { argv: [], cwd, redirects: [], heredoc: false }
  let tok = null
  let pendingRedirect = false
  const heredocs = []
  const endTok = () => {
    if (tok === null) return
    if (pendingRedirect) { seg.redirects.push(tok); pendingRedirect = false } else seg.argv.push(tok)
    tok = null
  }
  const endSeg = () => {
    endTok()
    if (seg.argv.length) {
      out.push(seg)
      if (CD.has(seg.argv[0].toLowerCase())) {
        const args = seg.argv.slice(1)
        let target = null
        for (let k = 0; k < args.length && target === null; k++) {
          if (/^-(literal)?path$/i.test(args[k])) target = args[k + 1] ?? null
          else if (!args[k].startsWith('-') && !/^\/d$/i.test(args[k])) target = args[k]
        }
        if (target) cwd = toPath(target, cwd, platform)
      }
    }
    seg = { argv: [], cwd, redirects: [], heredoc: false }
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (c === "'" || c === '"') {
      const here = tok === '@' && (next === '\n' || (next === '\r' && text[i + 2] === '\n'))
      if (here) {
        const close = text.indexOf(`\n${c}@`, i)
        const end = close < 0 ? text.length : close
        tok = text.slice(text.indexOf('\n', i) + 1, end)
        i = close < 0 ? text.length : close + 2
        continue
      }
      let j = i + 1
      let s = ''
      while (j < text.length && text[j] !== c) {
        if (c === '"' && text[j] === '\\' && ['"', '\\', '$', '`'].includes(text[j + 1])) { s += text[j + 1]; j += 2; continue }
        s += text[j++]
      }
      tok = (tok ?? '') + s
      i = j
      continue
    }
    if ((c === '\\' || c === '`') && (next === '\n' || (next === '\r' && text[i + 2] === '\n'))) {
      i += next === '\r' ? 2 : 1
      continue
    }
    if (c === '\n') {
      endSeg()
      while (heredocs.length) {
        const delim = heredocs.shift()
        let j = i + 1
        for (;;) {
          const nl = text.indexOf('\n', j)
          const line = text.slice(j, nl < 0 ? text.length : nl).replace(/\r$/, '')
          j = nl < 0 ? text.length : nl + 1
          if (line.trim() === delim || nl < 0) break
        }
        i = j - 1
      }
      continue
    }
    if (c === '#' && tok === null) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++
      continue
    }
    if (c === '<' && next === '<' && text[i + 2] !== '<') {
      endTok()
      let j = i + 2
      if (text[j] === '-') j++
      while (text[j] === ' ' || text[j] === '\t') j++
      const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(text.slice(j))
      if (m) { heredocs.push(m[2]); seg.heredoc = true; i = j + m[0].length - 1 } else i = j - 1
      continue
    }
    if (c === '>' || (c === '<' && tok === null)) {
      if (c === '>' && tok !== null && /^\d$/.test(tok)) tok = null
      endTok()
      let j = i + 1
      if (text[j] === '>' || text[j] === '|') j++
      if (text[j] === '&') {
        j++
        while (/\d|-/.test(text[j] ?? '')) j++
        i = j - 1
        continue
      }
      if (c === '>') pendingRedirect = true
      else { while (text[j] === ' ') j++; while (j < text.length && !/\s/.test(text[j])) j++ }
      i = j - 1
      continue
    }
    if (c === '&' && next === '>') { endTok(); pendingRedirect = true; i += next === '>' && text[i + 2] === '>' ? 2 : 1; continue }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      const piped = c === '|' && next !== '|' && seg.heredoc
      endSeg()
      if (piped) seg.heredoc = true
      if ((c === '&' || c === '|') && next === c) i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { endTok(); continue }
    tok = (tok ?? '') + c
  }
  endSeg()
  return out
}

const bin = (argv0) => basename(String(argv0).replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '')

// The repository a directory is in: its top level, and whether it is a main clone (git dir = common dir).
function repoAt(dir, run) {
  const r = run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
  if (!r.ok) return null
  const [top, gitDir, common] = r.out.split(/\r?\n/).map((l) => l.trim().replace(/\\/g, '/').replace(/\/$/, ''))
  if (!top || !gitDir || !common) return null
  return { top, main: gitDir.toLowerCase() === common.toLowerCase() }
}

export function defaultBranch(dir, run) {
  const head = run('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
  if (head.ok && head.out) return head.out.replace(/^[^/]+\//, '')
  for (const b of ['main', 'master']) if (run('git', ['-C', dir, 'rev-parse', '--verify', '-q', `refs/heads/${b}`]).ok) return b
  return 'main'
}

const isRef = (dir, name, run) =>
  run('git', ['-C', dir, 'rev-parse', '--verify', '-q', `${name}^{commit}`]).ok ||
  Boolean(run('git', ['-C', dir, 'for-each-ref', '--format=%(refname)', `refs/remotes/*/${name}`]).out)

// Where to do the work instead: the linked worktree that already has the branch, else the project's worktree tool, else git.
function worktreeFor(repo, target, run, env) {
  const list = run('git', ['-C', repo.top, 'worktree', 'list', '--porcelain'])
  if (target && list.ok) {
    for (const block of list.out.split(/\r?\n\r?\n/)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1]
      if (path && new RegExp(`^branch refs/heads/${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(block)) return `the worktree that has ${target}: ${path.replace(/\\/g, '/')}`
    }
  }
  try {
    const config = projectConfigPath(env, repo.top)
    const tool = config && sectionCommand(readFileSync(config, 'utf8'), 'worktree')
    if (tool) return `the project's worktree tool: ${tool}`
  } catch {}
  const name = (target || 'work').replace(/[^A-Za-z0-9._-]/g, '-')
  return `git -C ${repo.top} worktree add ${posix.dirname(repo.top)}/.worktrees/${name} ${target || '<ref>'}`
}

const WINDOWS_EDIT = 'On Windows the Bash tool halves a doubled backslash even inside single quotes, and a file may be CRLF on disk, so a scripted edit can wreck it without an error (three fix rounds in one epic): write the file with the Edit or Write tool.'

function check(seg, { run, env, platform }) {
  const at = seg.argv.findIndex((a) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) && !WRAPPERS.has(a))
  if (at < 0) return null
  const [first, ...rest] = seg.argv.slice(at)
  const name = bin(first)
  if (name === 'git') {
    let dir = seg.cwd
    let k = 0
    while (k < rest.length && rest[k].startsWith('-')) {
      if (rest[k] === '-C') { dir = toPath(rest[k + 1] ?? '.', dir, platform); k += 2 } else if (rest[k] === '-c') k += 2
      else k += 1
    }
    const sub = rest[k]
    const args = rest.slice(k + 1)
    if (sub === 'stash' && !['list', 'show'].includes(args[0])) {
      return 'Not run: git stash. A stash hides work from every other agent and from the branch, which is the witness: commit it on a branch in a worktree, and read another ref with git show <ref>:<path>.'
    }
    if (sub === 'push' && args.some((a) => a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || /^\+/.test(a))) {
      return 'Not run: a forced push. Bring a branch up to date by merging its base and pushing as usual; history others have read is never rewritten, and auto mode refused a dispatch that asked for a force push.'
    }
    if (sub === 'rebase' && !args.some((a) => ['--abort', '--continue', '--quit', '--skip', '--show-current-patch'].includes(a))) {
      return 'Not run: git rebase. Bring a branch up to date by merging its base (git merge origin/main), as its own commit; a rebase needs a force push, which is refused.'
    }
    if (sub === 'bisect') {
      const repo = repoAt(dir, run)
      if (!repo?.main || ['log', 'visualize', 'view', 'help'].includes(args[0])) return null
      return `Not run: ${repo.top} is a main clone, and git bisect detaches its HEAD. Bisect in a worktree: ${worktreeFor(repo, null, run, env)}.`
    }
    if (sub !== 'switch' && sub !== 'checkout') return null
    if (sub === 'checkout' && args.includes('--')) return null
    const flags = args.filter((a) => a.startsWith('-') && a !== '-')
    const target = args.find((a) => !a.startsWith('-') || a === '-')
    const creates = flags.some((f) => /^(-[bBcC]\S*|--create(=.*)?|--force-create(=.*)?|--orphan(=.*)?|--detach|-d)$/.test(f))
    if (!creates && !target) return null
    const repo = repoAt(dir, run)
    if (!repo || !repo.main) return null
    const base = defaultBranch(repo.top, run)
    if (!creates && target === base) return null
    if (sub === 'checkout' && !creates && target !== '-' && !isRef(repo.top, target, run)) return null
    const attached = flags.map((f) => /^(?:-[bBcC]|--create=|--force-create=|--orphan=)(.+)$/.exec(f)?.[1]).find(Boolean)
    const branch = creates ? attached ?? args.find((a, i) => /^(-[bBcC]|--create|--force-create|--orphan)$/.test(args[i - 1] ?? '')) ?? target : target === '-' ? null : target
    return `Not run: ${repo.top} is a main clone, and git ${sub} ${args.join(' ')} would move it off ${base}. A main clone stays on its default branch (three were left on a branch in one epic, and every sibling reading it went stale). Work in a worktree: ${worktreeFor(repo, branch, run, env)}. To read a file at another ref: git show <ref>:<path>.`
  }
  if (name === 'gh') {
    const [sub, verb] = rest
    if (sub === 'pr' && verb === 'merge') {
      return `Not run: gh pr merge. Merge only through the gate, which reads the merge state, the checks on the head and the threads itself: bash "${PLUGIN_ROOT}/scripts/gate.sh" <owner/repo> <pr> --merge. Never --admin.`
    }
    const named = seg.argv.slice(0, at).some((a) => /^GH_REPO=\S/.test(a))
    if (['pr', 'issue', 'run', 'workflow', 'release', 'label', 'cache'].includes(sub) && !named && !rest.some((a) => a === '-R' || a === '--repo' || a.startsWith('--repo=') || /^-R\S/.test(a)) && !rest.includes('--help')) {
      return `Not run: gh ${sub} ${verb ?? ''} without -R owner/repo. gh picks the repository from the working directory's remotes, upstream first, and answered about the wrong one four times in one epic: pass -R.`
    }
    return null
  }
  if (name === 'npm' && rest[0] === 'ci') {
    const repo = repoAt(seg.cwd, run)
    if (repo && !repo.main) return `Not run: npm ci in a linked worktree (${repo.top}). It costs 5-12 minutes each time, and the project's worktree tool links the main clone's dependencies; run it in the main clone if they are stale.`
    return null
  }
  if (platform === 'win32') {
    if (name === 'sed' && rest.some((a) => /^--in-place/.test(a) || /^-[a-zA-Z]*i/.test(a))) return `Not run: sed -i. ${WINDOWS_EDIT}`
    const fileTarget = seg.redirects.some((t) => !/^\/dev\/null$|^nul$|^\$null$/i.test(t))
    if (seg.heredoc && (fileTarget || (name === 'tee' && rest.some((a) => !a.startsWith('-'))))) return `Not run: a heredoc written to a file. ${WINDOWS_EDIT}`
  }
  return null
}

// Whether to block and why. `run` is lib/exec.mjs's, `platform` is process.platform's.
export function verdict(input, { env = process.env, epic = inEpic(input.session_id, env), run = realRun, platform = process.platform } = {}) {
  if (!['Bash', 'PowerShell'].includes(input.tool_name) || env.BATON_GUARD === '0' || !epic) return { block: false }
  const command = input.tool_input?.command
  if (!command) return { block: false }
  for (const seg of segments(command, toPath(input.cwd || process.cwd(), '/', platform), platform)) {
    const reason = check(seg, { run, env, platform })
    if (reason) return { block: true, reason }
  }
  return { block: false }
}

if (process.argv[1] && basename(process.argv[1]) === 'guard-hook.mjs') {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { process.exit(0) }
  try {
    const result = verdict(input)
    if (result.block) { console.error(result.reason); process.exit(2) }
  } catch (e) {
    console.error(`baton guard hook: ${e.message}; command allowed`)
  }
}
