// Which jobs a pull request never runs but its base branch will: the gate reads the workflows at the PR's head and names
// them, because a PR's green says nothing about them. The fixture follows the shapes of real workflows: an event test, a
// ref test, a job that needs a main-only job, a status function, a workflow with no pull_request trigger at all.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseWorkflow, mainOnlyJobs, evaluate } from '../scripts/lib/workflows.mjs'

const CHECK = `name: check

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize]
  schedule:
    - cron: "17 3 * * *"

jobs:
  # a comment
  tests:
    name: tests and conformance
    if: \${{ github.event_name != 'push' }}
    runs-on: ubuntu-latest
    steps:
      - name: only on main, a step
        if: github.ref == 'refs/heads/main'
        run: echo
  build-pages:
    runs-on: ubuntu-latest
    if: \${{ !cancelled() && (github.event_name == 'push' || github.event_name == 'schedule') && github.ref == 'refs/heads/main' }}
    steps: [{ run: echo }]
  pages:
    needs: [build-pages, tests]
    if: \${{ !cancelled() && needs.build-pages.result == 'success' }}
    runs-on: ubuntu-latest
  deploy:
    needs: pages
    runs-on: ubuntu-latest
  live:
    needs: pages
    if: \${{ !cancelled() && needs.pages.outputs.deployed == 'true' }}
    runs-on: ubuntu-latest
  release:
    if: >-
      github.event_name == 'push' &&
      github.ref_name == 'main'
    runs-on: ubuntu-latest
  publish:
    if: github.event_name == 'push' || (github.event.action != 'closed' && github.event.pull_request.head.repo.full_name == github.repository)
    runs-on: ubuntu-latest
  starter:
    if: \${{ !startsWith(github.base_ref, 'alpha/') }}
    runs-on: ubuntu-latest
  nightly-only:
    if: github.event_name != 'pull_request'
    needs:
      - tests
    runs-on: ubuntu-latest
`

const NIGHTLY = `on:
  schedule:
    - cron: "0 1 * * *"
  workflow_dispatch:
jobs:
  sweep:
    runs-on: ubuntu-latest
`

const PR_ONLY = `on: [pull_request]
jobs:
  ready:
    runs-on: ubuntu-latest
`

const TAGS = `on:
  push:
    tags: ['v*']
jobs:
  ship:
    runs-on: ubuntu-latest
`

test('parseWorkflow reads the triggers and each job\'s name, if and needs, not a step\'s if', () => {
  const w = parseWorkflow(CHECK)
  assert.deepEqual(Object.keys(w.on).sort(), ['pull_request', 'push', 'schedule'])
  assert.deepEqual(w.on.push.branches, ['main'])
  assert.deepEqual(w.jobs.map((j) => j.id), ['tests', 'build-pages', 'pages', 'deploy', 'live', 'release', 'publish', 'starter', 'nightly-only'])
  const by = Object.fromEntries(w.jobs.map((j) => [j.id, j]))
  assert.equal(by.tests.name, 'tests and conformance')
  assert.equal(by.tests.if, "github.event_name != 'push'")
  assert.deepEqual(by.pages.needs, ['build-pages', 'tests'])
  assert.deepEqual(by.deploy.needs, ['pages'])
  assert.deepEqual(by['nightly-only'].needs, ['tests'])
  assert.equal(by.release.if, "github.event_name == 'push' && github.ref_name == 'main'")
  assert.deepEqual(Object.keys(parseWorkflow(PR_ONLY).on), ['pull_request'])
  assert.deepEqual(parseWorkflow(TAGS).on.push.tags, ['v*'])
})

test('evaluate is three-valued: what the PR context cannot know stays unknown', () => {
  const ctx = { 'github.event_name': 'pull_request', 'github.base_ref': 'main' }
  assert.equal(evaluate("github.event_name == 'push'", ctx), false)
  assert.equal(evaluate("github.event_name != 'push'", ctx), true)
  assert.equal(evaluate("github.event_name == 'push' || github.event.action == 'x'", ctx), undefined)
  assert.equal(evaluate("github.event_name == 'push' && github.event.action == 'x'", ctx), false)
  assert.equal(evaluate("!startsWith(github.base_ref, 'alpha/')", ctx), true)
  assert.equal(evaluate("github.event_name == 'PULL_REQUEST'", ctx), true, 'string comparison ignores case')
  assert.equal(evaluate('!cancelled() && always()', ctx), true)
})

test('mainOnlyJobs names the jobs the PR never runs and main will, through needs, and whole workflows without a PR trigger', () => {
  const got = mainOnlyJobs([{ file: 'check.yml', text: CHECK }, { file: 'nightly.yml', text: NIGHTLY }, { file: 'ready.yml', text: PR_ONLY }, { file: 'tags.yml', text: TAGS }], { base: 'main' })
  assert.deepEqual(got.map((j) => `${j.file}: ${j.id}`), [
    'check.yml: build-pages', 'check.yml: pages', 'check.yml: deploy', 'check.yml: live', 'check.yml: release', 'check.yml: nightly-only', 'nightly.yml: sweep',
  ])
  assert.deepEqual(mainOnlyJobs([{ file: 'check.yml', text: CHECK }], { base: 'alpha/x', defaultBranch: 'main' }), [], 'a push to a branch the workflow does not name runs nothing, and a schedule runs the default branch')
  assert.deepEqual(mainOnlyJobs([{ file: 'bad.yml', text: ':\n  - [' }], { base: 'main' }), [], 'an unreadable file names nothing')
})

test('main-only.mjs prints one line per job, from files on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'))
  writeFileSync(join(dir, 'check.yml'), CHECK)
  writeFileSync(join(dir, 'ready.yml'), PR_ONLY)
  const script = fileURLToPath(new URL('../scripts/main-only.mjs', import.meta.url))
  const r = spawnSync(process.execPath, [script, '--base', 'main', join(dir, 'check.yml'), join(dir, 'ready.yml')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim().split('\n')[0], 'check.yml: build-pages')
  assert.equal(r.stdout.trim().split('\n').length, 6)
  assert.equal(spawnSync(process.execPath, [script, '--base', 'main'], { encoding: 'utf8' }).stdout, '', 'no files, no lines')
})
