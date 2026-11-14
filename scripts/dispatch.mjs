#!/usr/bin/env node
// Prints what an epic Agent call takes, so no prompt is written from memory:
//
//   node dispatch.mjs <role> "<step key>" "<subject>" [--input <file>] [--slot <n>] [--brief <file>] [--approved <file>]
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
// step, quoted: "w3 s07b" or "w0 #641". An input that fails its role's check (inputProblem) is refused, exit 2; a page
// step's approved text is printed on an `approved:` line after the five.

import { readFileSync, existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRoles } from './lib/roles.mjs'
import { projectConfigPath, sectionCommand } from './lib/machine.mjs'
import { stepOf, reasonFromFindings } from './lib/steps.mjs'
import { walkItems } from './walk-check.mjs'

export const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const slash = (p) => resolve(p).replace(/\\/g, '/')
// An issue or PR given by its URL is passed as it is; resolve() made it a path under the working directory.
const inputLine = (p) => (/^https?:\/\//.test(p) ? p : slash(p))

// The first command of the `## review_worktree` section, with the slot filled in.
export function reviewCall(configText, slot) {
  const code = sectionCommand(configText, 'review_worktree')
  if (!code || slot === undefined) return code
  return code.replace(/\[--slot <n>\]/, `--slot ${slot}`).replace(/--slot <n>/, `--slot ${slot}`)
}

const MAX_FINDINGS = 10
const LINE_CITE = /[\w./-]+\.(?:mjs|cjs|js|ts|tsx|jsx|py|md|sh|ya?ml|json|ttl|rs|html|css|toml):\d+/

// What a role's input file must hold, or the reason it is refused. A fix's findings: at most ten, a Test: line naming the
// targeted command and a Rerun: line saying which of the reviewer's probes were rerun on the head. A walk's input: a
// numbered list, which its handback reports item by item. A builder's step file: names, never line numbers; one that
// declares `kind: page` needs the text the maintainer approved.
function inputProblem(role, entry, input, approved) {
  const local = input && !/^https?:\/\//.test(input) && existsSync(input) ? readFileSync(input, 'utf8') : null
  if (role === 'walk') return local && walkItems(local).length ? null : 'a walk takes an input file with a numbered list of what to walk (--input <file>); its handback reports each item as walked or not walked'
  if (role === 'fix' && local !== null) {
    const n = String(local).split(/\r?\n/).filter((l) => /^\d+[.)]\s/.test(l)).length
    if (n > MAX_FINDINGS) return `the findings file holds ${n} findings; split it into two findings files of at most ${MAX_FINDINGS}, one fix agent each`
    if (!/^\s*Test:\s*\S/m.test(local)) return 'the findings file has no `Test: <command>` line: the targeted test command, as the repo really runs it'
    if (!/^\s*Rerun:\s*\S/m.test(local)) return 'the findings file has no `Rerun: <which>` line: which of the reviewer\'s probe results were rerun on the current head (or none)'
  }
  if (entry?.brief === 'builder.md' && local !== null) {
    const cite = LINE_CITE.exec(local)?.[0]
    if (cite) return `the step file cites a line number (${cite}); cite the file and the symbol, test or row text, which do not go stale within a wave`
    if (/^\s*kind:\s*page\s*$/im.test(local) && !(approved && existsSync(approved))) return 'the step file declares kind: page; pass --approved <file>, the plain text of the story and audience the maintainer approved, which the builder drafts from'
  }
  return null
}

export function dispatch({ role, step, subject, input, slot, brief, approved }, { roles = loadRoles(), env = process.env, cwd = process.cwd() } = {}) {
  const entry = roles.roles[role]
  if (!entry && !roles.defaultLocal?.[role]) throw new Error(`unknown role "${role}": ${[...Object.keys(roles.roles), ...Object.keys(roles.defaultLocal).filter((k) => k !== 'note')].join(', ')}`)
  if (!step || stepOf(step) !== String(step).trim().toLowerCase().replace(/\s+/g, ' ')) throw new Error(`step key "${step}" is not a wave and a step ("w3 s07b" or "w0 #641")`)
  if (!subject) throw new Error('no subject')
  const problem = inputProblem(role, entry, input, approved)
  if (problem) throw new Error(problem)
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
  const lines = [subject, briefPath, input ? inputLine(input) : '', cold ? '' : PLUGIN_ROOT, cold ? '' : slash(config)]
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
    approved: approved && existsSync(approved) ? slash(approved) : null,
    notes,
  }
}

export function render(d) {
  const out = [`description: ${d.description}`]
  if (d.model) out.push(`model: ${d.model}`, `effort: ${d.effort}`)
  out.push('---', ...d.lines.map((l, i) => `${i + 1}. ${l}`.trimEnd()))
  if (d.review) out.push(`review_worktree: ${d.review}`)
  if (d.approved) out.push(`approved: ${d.approved}`)
  return out.join('\n')
}

if (process.argv[1] && basename(process.argv[1]) === 'dispatch.mjs') {
  const args = process.argv.slice(2)
  const flags = {}
  const positional = []
  for (let i = 0; i < args.length; i++) {
    if (['--input', '--slot', '--brief', '--approved'].includes(args[i])) flags[args[i].slice(2)] = args[++i]
    else positional.push(args[i])
  }
  try {
    const d = dispatch({ role: positional[0], step: positional[1], subject: positional[2], ...flags })
    console.log(render(d))
    for (const n of d.notes) console.error(`note: ${n}`)
  } catch (e) {
    console.error(`dispatch.mjs: ${e.message}\nusage: dispatch.mjs <role> "<step key>" "<subject>" [--input <file>] [--slot <n>] [--brief <file>] [--approved <file>]`)
    process.exit(2)
  }
}
