// gate.sh --merge must say whether the merge happened: the orchestrator reads its exit code. It also names the jobs the PR
// never ran because they run on main only, and after a merge prints the wait on main's new head, or with --wait-main runs
// it when such jobs exist. A stub `gh` stands in for GitHub.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const gate = fileURLToPath(new URL('../scripts/gate.sh', import.meta.url)).replace(/\\/g, '/')
const BASH = process.env.BATON_TEST_BASH || 'bash'
const haveBash = spawnSync(BASH, ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok'
const bashIt = haveBash ? test : test.skip

const MERGED = 'f'.repeat(40)
const MAIN_ONLY = `on:
  push:
    branches: [main]
  pull_request:
jobs:
  tests:
    runs-on: ubuntu-latest
  build-pages:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
`
const PR_ONLY = 'on: [pull_request]\njobs:\n  tests:\n    runs-on: ubuntu-latest\n'

// A gh that reports an open, clean PR with passing checks and no open threads, serves one workflow file at the head,
// merges or fails as told, and reports main's run on the merge commit as told.
function stubGh({ mergeExit = 0, workflow = PR_ONLY, mainConclusion = 'success' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-')).replace(/\\/g, '/')
  const log = `${dir}/calls.log`
  writeFileSync(join(dir, 'check.yml'), workflow)
  const script = `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1 $2" in
  "pr view")
    case "$*" in
      *"--json state"*) echo OPEN ;;
      *mergeCommit*) echo ${MERGED} ;;
      *) echo "abc123 CLEAN main" ;;
    esac ;;
  "pr checks") case "$*" in *"-q '.[]|.name'"*|*".[]|.name"*) echo build ;; *) ;; esac ;;
  "api graphql") echo 0 ;;
  "api repos/o/r/contents/.github/workflows?ref=abc123") echo .github/workflows/check.yml; echo .github/workflows/README.md ;;
  "api -H") case "$*" in *check.yml*) cat "${dir}/check.yml" ;; *) exit 1 ;; esac ;;
  "repo view") echo main ;;
  "pr merge") ${mergeExit === 0 ? 'echo "merged by stub"' : 'echo "GraphQL: Pull Request is not mergeable" >&2'}; exit ${mergeExit} ;;
  "run list")
    case "$*" in
      *"-q length"*) echo 1 ;;
      *"--json status"*) ;;
      *"--json conclusion"*) echo ${mainConclusion} ;;
      *) echo "${mainConclusion}  check  run 1" ;;
    esac ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
`
  writeFileSync(join(dir, 'gh'), script)
  chmodSync(join(dir, 'gh'), 0o755)
  const cwd = mkdtempSync(join(tmpdir(), 'gate-cwd-'))
  return {
    dir,
    calls: () => readFileSync(log, 'utf8'),
    run: (args) => spawnSync(BASH, [gate, 'o/r', '5', ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, BATON_EVENTS: '0' } }),
  }
}

bashIt('gate.sh --merge exits non-zero, with gh\'s message, when gh pr merge fails; it does not say merged', () => {
  const r = stubGh({ mergeExit: 1 }).run(['--merge'])
  assert.notEqual(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /GATE PASSES/)
  assert.doesNotMatch(r.stdout, /^merged$/m)
  assert.match(r.stderr, /GraphQL: Pull Request is not mergeable/)
  assert.match(r.stderr, /MERGE FAILED/)
})

bashIt('gate.sh --merge exits 0, says merged and prints the wait on main\'s new head; without --merge it never merges', () => {
  const ok = stubGh()
  const merged = ok.run(['--merge'])
  assert.equal(merged.status, 0, merged.stdout + merged.stderr)
  assert.match(merged.stdout, /^merged$/m)
  assert.match(merged.stdout, new RegExp(`wait-ci\\.sh o/r --commit ${MERGED}`))
  assert.doesNotMatch(merged.stdout, /never ran/)
  const dry = stubGh({ mergeExit: 1 }).run([])
  assert.equal(dry.status, 0)
  assert.doesNotMatch(dry.stdout, /^merged$/m)
  assert.doesNotMatch(dry.stdout, /wait-ci/)
})

bashIt('gate.sh names the jobs the PR never ran, from the workflows at its head', () => {
  const s = stubGh({ workflow: MAIN_ONLY })
  const r = s.run([])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /jobs this PR never ran \(they run on main only\):\ncheck\.yml: build-pages/)
  assert.doesNotMatch(r.stdout, /check\.yml: tests/)
  assert.match(s.calls(), /contents\/\.github\/workflows\/check\.yml\?ref=abc123/)
  assert.doesNotMatch(s.calls(), /README\.md\?ref/, 'only .yml and .yaml files are read')
})

bashIt('gate.sh --merge --wait-main waits on main\'s new head when main-only jobs exist: exit 3 when main is red, 0 when green', () => {
  const red = stubGh({ workflow: MAIN_ONLY, mainConclusion: 'failure' }).run(['--merge', '--wait-main'])
  assert.equal(red.status, 3, red.stdout + red.stderr)
  assert.match(red.stdout, /^merged$/m)
  assert.match(red.stdout, /MAIN NOT PASSING/)
  const green = stubGh({ workflow: MAIN_ONLY }).run(['--merge', '--wait-main'])
  assert.equal(green.status, 0, green.stdout + green.stderr)
  assert.match(green.stdout, /main passed on ffff/)
  const none = stubGh({ mainConclusion: 'failure' })
  const skip = none.run(['--merge', '--wait-main'])
  assert.equal(skip.status, 0, 'no main-only jobs: the PR ran every job, so the gate does not wait')
  assert.doesNotMatch(none.calls(), /run list/)
  assert.match(skip.stdout, /wait-ci\.sh o\/r --commit/)
})
