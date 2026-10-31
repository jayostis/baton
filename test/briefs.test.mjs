// The epic's briefs, lessons and role table are checked here, in code, rather than asked for in prose: a brief past its
// cap, a lessons file past its cap, an agent that inherits its model, or a hook that points at nothing fails the suite.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRoles } from '../scripts/lib/roles.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const words = (p) => read(p).split(/\s+/).filter(Boolean).length // what wc -w counts

const CAPS = {
  'skills/epic/SKILL.md': 1500,
  'skills/epic/builder.md': 500,
  'skills/epic/reviewer.md': 450,
  'skills/epic/fix.md': 200,
  'skills/epic/critical-read.md': 500,
  'skills/epic/mechanical.md': 150,
  'skills/epic/walk.md': 400,
  'skills/epic/retro.md': 400,
  'references/handback.md': 400,
  'references/epic-step.yml': 400,
}

for (const [file, cap] of Object.entries(CAPS)) {
  test(`${file} is at most ${cap} words`, () => {
    assert.ok(words(file) <= cap, `${file} is ${words(file)} words, cap ${cap}`)
  })
}

test('HANDOFF template is at most 120 lines', () => {
  assert.ok(read('references/handoff.md').split('\n').length <= 120)
})

const LESSON_CAP = 80
const ROLE_TAGS = ['all', 'orchestrator', 'critical-read', 'builder', 'reviewer', 'fix', 'mechanical', 'walk']

test(`lessons.md is at most ${LESSON_CAP} lines, so every retro merges or deletes to add`, () => {
  const lines = read('references/lessons.md').split('\n').filter((l) => l.trim() !== '')
  assert.ok(lines.length <= LESSON_CAP, `lessons.md has ${lines.length} lines, cap ${LESSON_CAP}`)
})

test('every lesson is one line tagged by a role the briefs read, and the briefs name tags that exist', () => {
  const lines = read('references/lessons.md').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
  for (const l of lines) {
    const tag = /^\[([a-z-]+)\] \S/.exec(l)?.[1]
    assert.ok(ROLE_TAGS.includes(tag), `untagged or unknown tag: ${l.slice(0, 60)}`)
  }
  for (const f of readdirSync(join(root, 'skills/epic')).filter((n) => n.endsWith('.md') && n !== 'SKILL.md' && n !== 'retro.md')) {
    for (const [, tag] of read(`skills/epic/${f}`).matchAll(/`\[([a-z-]+)\]`/g)) assert.ok(ROLE_TAGS.includes(tag), `${f} reads tag ${tag}`)
  }
})

test('every role brief ends its agent with the handback block', () => {
  for (const f of ['builder', 'reviewer', 'fix', 'mechanical', 'critical-read', 'walk']) {
    assert.match(read(`skills/epic/${f}.md`), /references\/handback\.md/, `${f}.md does not name the handback block`)
  }
  for (const f of ['deliver/deliver-tests-agent', 'deliver/deliver-implement-agent', 'deliver/deliver-checklist-agent', 'quality/pr-review-followup-agent']) {
    assert.match(read(`agents/${f}.md`), /references\/handback\.md/, `${f}.md does not name the handback block`)
  }
})

test('the role table names a real brief and a model that has a weight, and no brief cites a line number', () => {
  const roles = loadRoles()
  for (const [role, v] of Object.entries(roles.roles)) {
    assert.ok(existsSync(join(root, 'skills/epic', v.brief)), `${role}: brief ${v.brief} does not exist`)
    assert.ok(['opus', 'sonnet', 'haiku'].includes(v.model), `${role}: model ${v.model}`)
    assert.ok(roles.weights.models[v.model] > 0)
  }
  for (const f of Object.keys(CAPS)) assert.doesNotMatch(read(f), /\.(mjs|md|sh|yml):\d+/, `${f} cites a file:line`)
})

test('no brief or skill names a path inside the plugin that does not exist', () => {
  for (const f of Object.keys(CAPS)) {
    for (const [, p] of read(f).matchAll(/`((?:references|scripts|skills|agents|hooks)\/[A-Za-z0-9_./-]+\.[a-z]+)`/g)) {
      assert.ok(existsSync(join(root, p)), `${f} names ${p}, which does not exist`)
    }
  }
})

test('every agent file names its model; none inherits', () => {
  const dirs = ['agents/deliver', 'agents/quality']
  let n = 0
  for (const d of dirs) {
    for (const f of readdirSync(join(root, d)).filter((x) => x.endsWith('.md'))) {
      const model = /^model: (\S+)$/m.exec(read(`${d}/${f}`))?.[1]
      assert.ok(['opus', 'sonnet', 'haiku'].includes(model), `${d}/${f} has model ${model}`)
      n++
    }
  }
  assert.equal(n, 4)
})

test('hooks.json wraps its events, and every hook runs a script that exists', () => {
  const hooks = JSON.parse(read('hooks/hooks.json')).hooks
  const pre = hooks.PreToolUse
  assert.deepEqual(pre.map((h) => h.matcher).sort(), ['Agent', 'SendMessage'])
  for (const entry of pre) {
    for (const h of entry.hooks) {
      assert.equal(h.type, 'command')
      const script = /\$\{CLAUDE_PLUGIN_ROOT\}\/(scripts\/[a-z-]+\.mjs)/.exec(h.command)?.[1]
      assert.ok(script && existsSync(join(root, script)), `${h.command} runs no script of ours`)
    }
  }
})

test('the manifest is version 2, takes a project config, and the README says how a project points at it', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'))
  assert.match(plugin.version, /^2\./)
  assert.equal(plugin.userConfig.project_config.type, 'file')
  assert.match(read('README.md'), /project_config/)
  assert.match(read('README.md'), /\.baton\/project\.md/)
})
