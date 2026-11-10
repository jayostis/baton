// gate.sh --merge must say whether the merge happened: the orchestrator reads its exit code. A stub `gh` stands in for GitHub.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const gate = fileURLToPath(new URL('../scripts/gate.sh', import.meta.url)).replace(/\\/g, '/')
const BASH = process.env.BATON_TEST_BASH || 'bash'
const haveBash = spawnSync(BASH, ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok'
const bashIt = haveBash ? test : test.skip

// A gh that reports an open, clean PR with passing checks and no open threads, and merges or fails as told.
function stubGh({ mergeExit }) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-'))
  const log = join(dir, 'calls.log').replace(/\\/g, '/')
  const script = `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1 $2" in
  "pr view")
    case "$*" in
      *"--json state"*) echo OPEN ;;
      *) echo "abc123 CLEAN main" ;;
    esac ;;
  "pr checks") case "$*" in *"-q '.[]|.name'"*) echo build ;; *) ;; esac ;;
  "api graphql") echo 0 ;;
  "pr merge") ${mergeExit === 0 ? 'echo "merged by stub"' : 'echo "GraphQL: Pull Request is not mergeable" >&2'}; exit ${mergeExit} ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
`
  writeFileSync(join(dir, 'gh'), script)
  chmodSync(join(dir, 'gh'), 0o755)
  return { dir, run: (args) => spawnSync(BASH, [gate, 'o/r', '5', ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: `${dir.replace(/\\/g, '/')}${delimiter}${process.env.PATH}`, BATON_EVENTS: '0' } }) }
}

bashIt('gate.sh --merge exits non-zero, with gh\'s message, when gh pr merge fails; it does not say merged', () => {
  const r = stubGh({ mergeExit: 1 }).run(['--merge'])
  assert.notEqual(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /GATE PASSES/)
  assert.doesNotMatch(r.stdout, /^merged$/m)
  assert.match(r.stderr, /GraphQL: Pull Request is not mergeable/)
  assert.match(r.stderr, /MERGE FAILED/)
})

bashIt('gate.sh --merge exits 0 and says merged when gh pr merge succeeds; without --merge it never merges', () => {
  const ok = stubGh({ mergeExit: 0 })
  const merged = ok.run(['--merge'])
  assert.equal(merged.status, 0, merged.stdout + merged.stderr)
  assert.match(merged.stdout, /^merged$/m)
  const dry = stubGh({ mergeExit: 1 }).run([])
  assert.equal(dry.status, 0)
  assert.doesNotMatch(dry.stdout, /^merged$/m)
})
