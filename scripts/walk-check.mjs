#!/usr/bin/env node
// Whether a walk reported every item of its input, walked or not walked:
//
//   node walk-check.mjs <input file> <handback file | ->
//
// The input's items are its top-level numbered lines ("3. Hub search box"); the handback reports each on a line of its
// own, "3. walked: <what you saw>" or "3. not walked: <why>". Exit 0 when every item is reported, 1 naming the ones that
// are not, 2 for an input with no numbered list. The SubagentHandback hook (walk-hook.mjs) runs this before a walk can
// hand back, and ledger.mjs --agent prints it under a walk's line. A first walk once covered half its list.

import { readFileSync } from 'node:fs'
import { isMain } from './lib/exec.mjs'

export function walkItems(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const n = /^ {0,3}(\d+)[.)]\s+\S/.exec(line)?.[1]
    if (n && !out.includes(Number(n))) out.push(Number(n))
  }
  return out
}

const REPORT = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:item\s+)?(\d+)(?:\*\*|__)?[.):]?(?:\*\*|__)?\s*(?:[-:–—]\s*)?(?:\*\*|__|_)?(not walked|walked)\b/i

export function uncovered(inputText, handbackText) {
  const reported = new Set()
  for (const line of String(handbackText ?? '').split(/\r?\n/)) {
    const n = REPORT.exec(line)?.[1]
    if (n) reported.add(Number(n))
  }
  return walkItems(inputText).filter((n) => !reported.has(n))
}

// The verdict as one line, and whether it holds.
export function verdictLine(inputText, handbackText) {
  const items = walkItems(inputText)
  if (!items.length) return { ok: false, line: 'the input has no numbered list, so no item can be reported' }
  const missing = uncovered(inputText, handbackText)
  if (!missing.length) return { ok: true, line: `all ${items.length} items reported` }
  return { ok: false, line: `item${missing.length > 1 ? 's' : ''} ${missing.join(', ')} of ${items.length} ${missing.length > 1 ? 'are' : 'is'} not reported as walked or not walked` }
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '')

// A walk agent's input path (its prompt's line 3) and its handback (the SubagentHandback message, else its last text).
export function walkOf(transcriptPath) {
  let prompt = null
  let handback = null
  let lastText = null
  for (const raw of readFileSync(transcriptPath, 'utf8').split('\n')) {
    let e
    try { e = JSON.parse(raw) } catch { continue }
    if (prompt === null && e.type === 'user' && e.message) prompt = textOf(e.message.content)
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue
    for (const c of e.message.content) {
      if (c?.type === 'tool_use' && c.name === 'SubagentHandback' && typeof c.input?.message === 'string') handback = c.input.message
      if (c?.type === 'text' && c.text?.trim()) lastText = c.text
    }
  }
  const input = /^3\.\s+(.+?)\s*$/m.exec(prompt ?? '')?.[1] ?? null
  return { prompt, input, handback: handback ?? lastText }
}

if (isMain(import.meta.url)) {
  const [input, handback] = process.argv.slice(2)
  if (!input || !handback) { console.error('usage: walk-check.mjs <input file> <handback file | ->'); process.exit(2) }
  try {
    const inputText = readFileSync(input, 'utf8')
    const v = verdictLine(inputText, readFileSync(handback === '-' ? 0 : handback, 'utf8'))
    console.log(v.line)
    process.exit(v.ok ? 0 : walkItems(inputText).length ? 1 : 2)
  } catch (e) {
    console.error(`walk-check.mjs: ${e.message}`)
    process.exit(2)
  }
}
