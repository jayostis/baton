// The shell guard: one PreToolUse hook on Bash and PowerShell, in an epic only, that refuses the commands lessons used to
// forbid in prose. A main clone and a linked worktree are real git repositories in Temp; the hook is run as the harness
// runs it (stdin, exit code, stderr), and verdict() is called directly for the cases that need no repository.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, realpathSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

// The repos these tests build are in Temp, which the guard exempts; its Temp is pointed elsewhere unless a test says otherwise.
const NOT_TEMP = { TEMP: '/baton-not-temp', TMP: '/baton-not-temp', TMPDIR: '/baton-not-temp' }
const REAL_TEMP = { TEMP: tmpdir(), TMP: tmpdir(), TMPDIR: tmpdir() }

const hook = (command, cwd, { tool = 'Bash', env = {} } = {}) => {
  const r = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, BATON_EPIC: '1', BATON_PROJECT_CONFIG: '', GH_REPO: '', ...NOT_TEMP, ...env },
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
  assert.equal(hook('npm ci', wt).status, 0, 'a worktree whose node_modules is not linked needs it')
  mkdirSync(join(wt, 'node_modules'))
  assert.match(hook('npm ci', wt).stderr, /npm ci/)
  assert.equal(hook('npm ci', wt).status, 2, 'a worktree whose node_modules is linked does not')
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

test('guard: a scratch repository, one without an origin or under Temp, is not a main clone', () => {
  const root = fwd(realpathSync(mkdtempSync(join(tmpdir(), 'g-'))))
  git(root, 'init', 'scratch')
  const scratch = `${root}/scratch`
  writeFileSync(join(scratch, 'a.txt'), 'a\n')
  git(scratch, 'add', 'a.txt')
  git(scratch, 'commit', '-m', 'one')
  for (const cmd of ['git switch -c topic', 'git checkout HEAD~0', 'git checkout --detach']) {
    assert.equal(hook(cmd, scratch, { env: REAL_TEMP }).status, 0, `${cmd} in a scratch repo under Temp`)
    assert.equal(hook(cmd, scratch).status, 0, `${cmd} in a repo with no origin`)
  }
  const { main } = repos()
  assert.equal(hook('git switch -c x', main, { env: REAL_TEMP }).status, 0, 'a clone with an origin, but under Temp')
  assert.equal(hook('git switch -c x', main).status, 2, 'a clone with an origin, not under Temp')
})

test('guard: a heredoc is refused only when cat, tee, printf or echo writes it to a file', () => {
  const at = (command) => verdict({ tool_name: 'Bash', cwd: '.', tool_input: { command } }, { epic: true, platform: 'win32' })
  for (const cmd of ["node - <<'EOF' > out.json\nx\nEOF", "cat <<'EOF' | node x.mjs > result.txt\nx\nEOF", "python - <<'EOF' 2>&1 | tee run.log\nx\nEOF"]) assert.equal(at(cmd).block, false, cmd)
  for (const cmd of ["cat > f.txt <<'EOF'\nx\nEOF", "cat <<'EOF' > f.txt\nx\nEOF", "printf %s - <<'EOF' > f.txt\nx\nEOF", "cat <<'EOF' | tee f.txt\nx\nEOF", "tee f.txt <<'EOF'\nx\nEOF"]) assert.equal(at(cmd).block, true, cmd)
})

test('guard: gh pr checkout in a main clone, global flags before the subcommand, and GH_REPO set earlier', () => {
  const { main, wt } = repos()
  assert.equal(hook('gh pr checkout 3 -R o/r', main).status, 2, 'it moves the clone off main')
  assert.match(hook('gh pr checkout 3 -R o/r', main).stderr, /main clone/)
  assert.equal(hook('gh pr checkout 3 -R o/r', wt).status, 0)
  assert.equal(hook('gh -R o/r pr merge 3', wt).status, 2)
  assert.match(hook('gh -R o/r pr merge 3', wt).stderr, /gate/)
  assert.equal(hook('gh -R o/r pr view 3', wt).status, 0)
  assert.equal(hook('gh --repo o/r pr view 3', wt).status, 0)
  assert.equal(hook('gh pr view 3', wt).status, 2)
  assert.equal(hook('export GH_REPO=o/r && gh pr view 5', wt).status, 0)
  assert.equal(hook("$env:GH_REPO='o/r'; gh pr view 5", wt, { tool: 'PowerShell' }).status, 0)
  assert.equal(hook('gh pr view 5', wt, { env: { GH_REPO: 'o/r' } }).status, 0, 'GH_REPO in the session environment')
  assert.equal(hook('gh pr view 5 && export GH_REPO=o/r', wt).status, 2, 'set after, not before')
})

test('guard: a cd inside parentheses does not change the directory after them', () => {
  const { main, wt } = repos()
  assert.equal(hook(`(cd ${main} && ls); git switch -c y`, wt).status, 0)
  assert.equal(hook(`(cd ${main} && git switch -c y)`, wt).status, 2, 'still read inside')
  assert.equal(hook(`cd ${main} && git switch -c y`, wt).status, 2)
  assert.deepEqual(segments('(cd /x && ls); pwd', '/a').map((s) => s.cwd), ['/a', '/x', '/a'])
})

test('guard: a clone whose git config names baton.homeBranch may move to it', () => {
  const { main } = repos()
  git(main, 'branch', 'site-docs')
  assert.equal(hook('git switch site-docs', main).status, 2)
  git(main, 'config', 'baton.homeBranch', 'site-docs')
  assert.equal(hook('git switch site-docs', main).status, 0)
  assert.equal(hook('git checkout site-docs', main).status, 0)
  assert.equal(hook('git switch main', main).status, 0)
  assert.equal(hook('git switch feature', main).status, 2)
  assert.match(hook('git switch feature', main).stderr, /off site-docs/)
})

test('docs: every gh call in the skills and agents names its repository with -R', () => {
  const md = (d) => readdirSync(d).flatMap((n) => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? md(p) : p.endsWith('.md') ? [p] : [] })
  const root = fwd(fileURLToPath(new URL('..', import.meta.url)))
  const bad = []
  for (const file of [...md(`${root}skills`), ...md(`${root}agents`)]) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/\bgh (?:pr|issue|run|workflow|release|label|cache) [a-z-]+/g)) {
      const before = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index)
      const open = (before.match(/`/g) || []).length % 2 === 1
      const stops = [text.indexOf('`', m.index), open ? -1 : text.indexOf('\n', m.index)].filter((i) => i >= 0)
      const call = text.slice(m.index, stops.length ? Math.min(...stops) : undefined)
      if (!/(^|\s)(-R|--repo)\b|--help/.test(call)) bad.push(`${file.slice(root.length)}:${text.slice(0, m.index).split('\n').length} ${call}`)
    }
  }
  assert.deepEqual(bad, [], 'a doc that tells an agent to run gh without -R tells it to run a refused command')
})
