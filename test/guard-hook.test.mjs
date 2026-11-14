// The shell guard: one PreToolUse hook on Bash and PowerShell, in an epic only, that refuses the commands lessons used to
// forbid in prose. A main clone and a linked worktree are real git repositories in Temp; the hook is run as the harness
// runs it (stdin, exit code, stderr), and verdict() is called directly for the cases that need no repository.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verdict, segments } from '../scripts/guard-hook.mjs'

const script = fileURLToPath(new URL('../scripts/guard-hook.mjs', import.meta.url))
const fwd = (p) => p.replace(/\\/g, '/')
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env: gitEnv })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// A bare origin, a main clone of it on main with a branch `feature`, and a linked worktree on `feature`.
function repos() {
  const root = fwd(realpathSync(mkdtempSync(join(tmpdir(), 'g-'))))
  git(root, 'init', '--bare', '-b', 'main', 'o.git')
  git(root, 'clone', 'o.git', 'main')
  const main = `${root}/main`
  writeFileSync(join(main, 'a.txt'), 'a\n')
  git(main, 'add', 'a.txt')
  git(main, 'commit', '-m', 'one')
  git(main, 'push', 'origin', 'main')
  git(main, 'branch', 'feature')
  git(main, 'worktree', 'add', `${root}/wt`, 'feature')
  return { root, main, wt: `${root}/wt` }
}

const hook = (command, cwd, { tool = 'Bash', env = {} } = {}) => {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, BATON_EPIC: '1', BATON_PROJECT_CONFIG: '', ...env },
  })
  return { status: r.status, stderr: r.stderr }
}

test('guard: a main clone is not moved off its default branch, by cwd, cd or git -C; the refusal names the worktree to use', () => {
  const { root, main, wt } = repos()
  for (const cmd of ['git switch feature', 'git checkout feature', 'git checkout -b x', 'git switch -c x', 'git checkout --detach', 'git checkout -', 'git checkout HEAD~0', 'git switch --detach main', 'git switch --create=x', 'git checkout -bx', 'git bisect start', '(cd . && git switch feature)', 'command git switch feature', 'env X=1 git switch feature']) {
    const r = hook(cmd, main)
    assert.equal(r.status, 2, `${cmd} in a main clone`)
    assert.match(r.stderr, /main clone/)
  }
  const named = hook('git switch feature', main)
  assert.ok(named.stderr.includes(wt), `names the worktree that has feature: ${named.stderr}`)
  assert.match(hook('git checkout -b x', main).stderr, /worktree add/)
  assert.equal(hook(`cd ${main} && git switch feature`, root).status, 2)
  assert.equal(hook(`cd "${main}"; git checkout feature`, root).status, 2)
  assert.equal(hook(`git -C ${main} checkout feature`, root).status, 2)
  assert.equal(hook(`Set-Location ${main}; git switch feature`, root, { tool: 'PowerShell' }).status, 2)
  assert.equal(hook(`git -C "${main}" switch feature`, root, { tool: 'PowerShell' }).status, 2)
  if (process.platform === 'win32') assert.equal(hook(`cd /${main[0].toLowerCase()}${main.slice(2)} && git switch feature`, root).status, 2, 'a Git Bash path')
})

test('guard: restoring files, returning to the default branch and anything in a linked worktree pass', () => {
  const { root, main, wt } = repos()
  for (const cmd of ['git checkout main', 'git switch main', 'git checkout -- a.txt', 'git checkout feature -- a.txt', 'git checkout a.txt', 'git restore a.txt', 'git status', 'git checkout', 'git log --oneline -3', 'git worktree add ../w2 feature']) {
    assert.equal(hook(cmd, main).status, 0, `${cmd} in a main clone`)
  }
  for (const cmd of ['git switch -c y', 'git checkout -b z', 'git checkout --detach']) assert.equal(hook(cmd, wt).status, 0, `${cmd} in a worktree`)
  assert.equal(hook(`git -C ${wt} checkout -b q`, root).status, 0)
  assert.equal(hook(`cd ${wt} && git switch -c r`, main).status, 0)
  assert.equal(hook('git switch feature', root).status, 0, 'not a repository at all')
})

test('guard: quoted text and heredoc bodies are not commands', () => {
  const { main } = repos()
  assert.equal(hook('git commit -m "then git switch feature"', main).status, 0)
  assert.equal(hook("git commit -F - <<'EOF'\nfix: git switch feature left a clone\ngit stash\nEOF\ngit status", main).status, 0)
  assert.equal(hook("git commit -F - <<'EOF'\nbody\nEOF\ngit switch feature", main).status, 2, 'a command after the heredoc is still read')
  assert.equal(hook("git commit -m @'\ngit switch feature\n'@", main, { tool: 'PowerShell' }).status, 0)
})

test('guard: git stash, a forced push, a rebase, gh without -R, a merge outside the gate and npm ci in a worktree are refused', () => {
  const { main, wt } = repos()
  const refused = [
    ['git stash', main, /stash/], ['git stash pop', wt, /stash/], ['git stash push -m x', wt, /stash/],
    ['git push --force', wt, /force/], ['git push -f origin feature', wt, /force/], ['git push origin +feature', wt, /force/], ['git push --force-with-lease', wt, /force/],
    ['git rebase main', wt, /rebase/],
    ['gh pr view 5', wt, /-R/], ['gh issue list', wt, /-R/], ['gh run rerun 9', wt, /-R/],
    ['gh pr merge 5 -R o/r --merge', wt, /gate/], ['gh pr merge 5 -R o/r --admin', wt, /gate/],
    ['npm ci', wt, /npm ci/],
  ]
  for (const [cmd, cwd, why] of refused) {
    const r = hook(cmd, cwd)
    assert.equal(r.status, 2, cmd)
    assert.match(r.stderr, why, cmd)
  }
  assert.equal(hook('git bisect start', wt).status, 0, 'a bisect in a worktree')
  const passed = ['GH_REPO=o/r gh pr view 5', 'git stash list', 'git stash show', 'git push origin feature', 'git push -u origin feature', 'git rebase --abort', 'gh pr view 5 -R o/r', 'gh pr view 5 --repo=o/r', 'gh api repos/o/r/pulls', 'gh auth status', 'bash scripts/gate.sh o/r 5 --merge']
  for (const cmd of passed) assert.equal(hook(cmd, wt).status, 0, cmd)
  assert.equal(hook('npm ci', main).status, 0, 'npm ci belongs in a main clone')
})

test('guard: on Windows, sed -i and a heredoc written to a file are refused; a heredoc fed to a command passes', () => {
  const at = (command) => verdict({ tool_name: 'Bash', cwd: '.', tool_input: { command } }, { epic: true, platform: 'win32' })
  assert.equal(at("sed -i 's/a/b/' f.txt").block, true)
  assert.match(at("sed -i 's/a/b/' f.txt").reason, /Edit/)
  assert.equal(at("cat > f.txt <<'EOF'\na\\\\b\nEOF").block, true)
  assert.equal(at("cat <<'EOF' > f.txt\nx\nEOF").block, true)
  assert.equal(at("tee f.txt <<'EOF'\nx\nEOF").block, true)
  assert.equal(at("cat <<'EOF' | tee f.txt\nx\nEOF").block, true, 'a heredoc piped into tee')
  assert.equal(at("cat <<'EOF' | node x.mjs\nx\nEOF").block, false)
  assert.equal(at("git commit -F - <<'EOF'\nx\nEOF").block, false)
  assert.equal(at("node x.mjs <<'EOF' 2>&1\nx\nEOF").block, false)
  assert.equal(at("sed -n '1,5p' f.txt").block, false)
  assert.equal(verdict({ tool_name: 'Bash', cwd: '.', tool_input: { command: "sed -i 's/a/b/' f" } }, { epic: true, platform: 'linux' }).block, false)
})

test('guard: outside an epic, on another tool, or on input it cannot read, nothing is refused', () => {
  const { main } = repos()
  assert.equal(hook('git switch feature', main, { env: { BATON_EPIC: '' } }).status, 0)
  assert.equal(verdict({ tool_name: 'Read', cwd: main, tool_input: { command: 'git stash' } }, { epic: true }).block, false)
  assert.equal(spawnSync(process.execPath, [script], { input: 'garbage', encoding: 'utf8', env: { ...process.env, BATON_EPIC: '1' } }).status, 0)
  assert.equal(hook('git switch feature', join(main, 'missing')).status, 0, 'a cwd that does not exist')
})

test('segments: splits on && || ; | and newlines outside quotes, follows cd, and skips heredoc bodies', () => {
  const s = segments("cd /xy/z && git a 'b; c' | wc\ngit d <<EOF\ngit e\nEOF\ngit f", '/start')
  assert.deepEqual(s.map((x) => x.argv), [['cd', '/xy/z'], ['git', 'a', 'b; c'], ['wc'], ['git', 'd'], ['git', 'f']])
  assert.equal(s[1].cwd, '/xy/z')
  assert.equal(segments('cd sub; git x', '/start/a')[1].cwd, '/start/a/sub')
})
