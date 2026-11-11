#!/usr/bin/env node
// Prints what an epic Agent call takes, so no prompt is written from memory:
//
//   node dispatch.mjs <role> "<step key>" "<subject>" [--input <file>] [--slot <n>] [--brief <file>]
//
//   description: <role>: <step key> [<reason>] <subject, shortened>     what to pass as `description`
//   model, effort                                                       from references/roles.json
//   ---
//   1. <subject>   2. <brief>   3. <input file>   4. <plugin root>   5. <project config>
//
// The brief is the role's, from the role table; --brief names one for a role the table has none for (such as
// cold-read). A cold-read prompt leaves lines 4 and 5 blank: the reader opens nothing but the page. A review role gets one
// more line, `review_worktree:`, copied from the project config's `## review_worktree` entry (its first indented command),
// with `--slot <n>` where the config has `[--slot <n>]`; the repo and ref placeholders it names are the orchestrator's to
// fill. A fix role's reason is the `Reason: <word>` line its findings file opens with. The step key is the wave and the
// step, quoted: "w3 s07b" or "w0 #641".

import { readFileSync, existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRoles } from './lib/roles.mjs'
import { projectConfigPath } from './lib/machine.mjs'
import { stepOf, reasonFromFindings } from './lib/steps.mjs'

export const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const slash = (p) => resolve(p).replace(/\\/g, '/')

// The first indented command of the `## review_worktree` section, or a fenced one.
export function reviewCall(configText, slot) {
  let inside = false
  let fenced = false
  for (const line of String(configText).split('\n')) {
    const heading = /^#{1,6}\s*(.*?)\s*$/.exec(line)
    if (heading && !fenced) { inside = heading[1].toLowerCase() === 'review_worktree'; continue }
    if (!inside) continue
    if (/^\s*```/.test(line)) { fenced = !fenced; continue }
    const code = fenced ? line.trim() : /^(?: {4}|\t)(\S.*)$/.exec(line)?.[1]
    if (!code) continue
    return slot === undefined ? code : code.replace(/\[--slot <n>\]/, `--slot ${slot}`).replace(/--slot <n>/, `--slot ${slot}`)
  }
  return null
}

export function dispatch({ role, step, subject, input, slot, brief }, { roles = loadRoles(), env = process.env, cwd = process.cwd() } = {}) {
  const entry = roles.roles[role]
  if (!entry && !roles.defaultLocal?.[role]) throw new Error(`unknown role "${role}": ${[...Object.keys(roles.roles), ...Object.keys(roles.defaultLocal).filter((k) => k !== 'note')].join(', ')}`)
  if (!step || stepOf(step) !== String(step).trim().toLowerCase().replace(/\s+/g, ' ')) throw new Error(`step key "${step}" is not a wave and a step ("w3 s07b" or "w0 #641")`)
  if (!subject) throw new Error('no subject')
  const notes = []
  const cold = role === 'cold-read'
  const config = cold ? null : projectConfigPath(env, cwd)
  if (!cold && !config) throw new Error('no project config: set BATON_PROJECT_CONFIG or the project_config option, or add .baton/project.md')
  const briefPath = brief ? slash(brief) : entry ? `${PLUGIN_ROOT}/skills/epic/${entry.brief}` : ''
  if (!briefPath) notes.push(`${role} has no brief in the role table; pass --brief <file>`)
  let reason = ''
  if (role === 'fix') {
    const found = input && existsSync(input) ? reasonFromFindings(readFileSync(input, 'utf8')) : null
    if (!found) notes.push('the findings file does not open with `Reason: <word>`; the round is counted as other')
    reason = `${found ?? 'other'} `
  }
  const short = String(subject).replace(/\s+/g, ' ').trim().slice(0, 40).trim()
  const lines = [subject, briefPath, input ? slash(input) : '', cold ? '' : PLUGIN_ROOT, cold ? '' : slash(config)]
  let review = null
  if (role.startsWith('review')) {
    review = reviewCall(readFileSync(config, 'utf8'), slot)
    if (!review) notes.push('the project config has no `## review_worktree` command')
  }
  return {
    description: `${role}: ${stepOf(step)} ${reason}${short}`,
    model: entry?.model ?? null,
    effort: entry?.effort ?? null,
    lines,
    review,
    notes,
  }
}

export function render(d) {
  const out = [`description: ${d.description}`]
  if (d.model) out.push(`model: ${d.model}`, `effort: ${d.effort}`)
  out.push('---', ...d.lines.map((l, i) => `${i + 1}. ${l}`.trimEnd()))
  if (d.review) out.push(`review_worktree: ${d.review}`)
  return out.join('\n')
}

if (process.argv[1] && basename(process.argv[1]) === 'dispatch.mjs') {
  const args = process.argv.slice(2)
  const flags = {}
  const positional = []
  for (let i = 0; i < args.length; i++) {
    if (['--input', '--slot', '--brief'].includes(args[i])) flags[args[i].slice(2)] = args[++i]
    else positional.push(args[i])
  }
  try {
    const d = dispatch({ role: positional[0], step: positional[1], subject: positional[2], ...flags })
    console.log(render(d))
    for (const n of d.notes) console.error(`note: ${n}`)
  } catch (e) {
    console.error(`dispatch.mjs: ${e.message}\nusage: dispatch.mjs <role> "<step key>" "<subject>" [--input <file>] [--slot <n>] [--brief <file>]`)
    process.exit(2)
  }
}
