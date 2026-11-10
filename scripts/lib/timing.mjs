// Where one agent's wall time went, read from its transcript's timestamps: inside tool calls, or between them (the model
// thinking, writing and waiting for a turn). A tool call runs from the record that asked for it to the record that
// returned its result, so this costs nothing at run time and needs no marker from the agent.

import { readFileSync, existsSync } from 'node:fs'
import { instant } from './transcript.mjs'

export const KINDS = ['heavy', 'ci', 'git', 'read', 'other']
const SHELLS = new Set(['Bash', 'PowerShell'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'ToolSearch'])
const READ_COMMANDS = /^(cat|ls|head|tail|rg|grep|find|wc|sed|awk|stat|diff|jq|cd|echo|pwd|test|\[)(\s|$)/

// Heavy is a test runner, a build or a docker run: a short pattern list of this report's own, not the project's machine
// section. A `grep pytest` or an `echo` of one is not a run.
const HEAVY = /(^|\s)(heavy\.sh|pytest|vitest|node\s[^|;&]*--test|npm\s+(run\s+)?(test|build|lint)|npx\s+(vitest|tsc)|tsc\s+-b|cargo\s+(test|nextest|build)|docker\s+run|playwright)(\s|$)/

// The kind of a tool call, first match wins: heavy, CI wait, git or gh, read or search, other. A command that sleeps in a
// loop is waiting on a background job: CI if it names gh or wait-ci.sh, else the heavy run it waits for.
export function kindOf(tool, input) {
  if (!SHELLS.has(tool)) return READ_TOOLS.has(tool) ? 'read' : 'other'
  const cmd = typeof input?.command === 'string' ? input.command : ''
  const parts = cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean)
  if (parts.some((s) => !/^(grep|rg|cat|echo|head|tail)\s/.test(s) && HEAVY.test(s))) return 'heavy'
  const sleeps = /(^|[\s;&|])sleep\s+\d/.test(cmd)
  if (/wait-ci\.sh|gh\s+run\s+watch|--watch\b/.test(cmd) || (sleeps && /(^|\s)gh\s/.test(cmd))) return 'ci'
  if (sleeps) return 'heavy'
  if (/gate\.sh/.test(cmd) || parts.some((s) => /^(git|gh)\s/.test(s))) return 'git'
  if (parts.length && parts.every((s) => READ_COMMANDS.test(s))) return 'read'
  return 'other'
}

const textOf = (input) => String(input?.command ?? input?.file_path ?? input?.path ?? input?.pattern ?? input?.description ?? input?.prompt ?? JSON.stringify(input ?? {})).replace(/\s+/g, ' ').trim()

// Wall, tool and model milliseconds, tool milliseconds by kind, the five longest calls, and every call (for joining an
// event to the agent that made it). Tool time is the union of the calls' intervals, so parallel calls are not counted
// twice; the kinds are scaled to sum to it.
export function timeSplit(path) {
  if (!existsSync(path)) return null
  const open = new Map()
  const calls = []
  let first = NaN
  let last = NaN
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    const at = instant(r.timestamp)
    if (Number.isFinite(at)) { if (!Number.isFinite(first)) first = at; last = at }
    const content = r.message?.content
    if (!Number.isFinite(at) || !Array.isArray(content)) continue
    if (r.type === 'assistant') {
      for (const c of content) if (c.type === 'tool_use') open.set(c.id, { tool: c.name, input: c.input, start: at })
    } else if (r.type === 'user') {
      for (const c of content) {
        const call = c.type === 'tool_result' && open.get(c.tool_use_id)
        if (!call) continue
        open.delete(c.tool_use_id)
        calls.push({ tool: call.tool, text: textOf(call.input).slice(0, 400), kind: kindOf(call.tool, call.input), start: call.start, end: Math.max(at, call.start) })
      }
    }
  }
  if (!Number.isFinite(first)) return null
  const spans = calls.map((c) => [c.start, c.end]).sort((a, b) => a[0] - b[0])
  let toolMs = 0
  let [from, to] = spans[0] ?? [0, 0]
  for (const [s, e] of spans.slice(1)) {
    if (s > to) { toolMs += to - from; from = s; to = e } else to = Math.max(to, e)
  }
  toolMs += to - from
  const summed = calls.reduce((n, c) => n + (c.end - c.start), 0)
  const kinds = Object.fromEntries(KINDS.map((k) => [k, 0]))
  for (const c of calls) kinds[c.kind] += summed ? ((c.end - c.start) * toolMs) / summed : 0
  const wallMs = last - first
  return {
    start: first,
    end: last,
    wallMs,
    toolMs: Math.min(toolMs, wallMs),
    modelMs: Math.max(0, wallMs - toolMs),
    kinds,
    top: [...calls].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 5).map((c) => ({ tool: c.tool, text: c.text.slice(0, 80), seconds: Math.round((c.end - c.start) / 1000) })),
    calls,
  }
}

// The orchestrator's `gate.sh <owner/repo> <pr> --merge` calls whose result says `merged`: {at, repo, pr}. What stands in
// for a merge event in a session that ran before the events existed.
export function transcriptMerges(path) {
  if (!existsSync(path)) return []
  const open = new Map()
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('--merge') && !line.includes('"tool_result"')) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    const content = r.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c.type === 'tool_use' && SHELLS.has(c.name) && /gate/.test(c.input?.command ?? '') && /--merge/.test(c.input?.command ?? '')) {
        open.set(c.id, [...String(c.input.command).matchAll(/([\w.-]+\/[\w.-]+)\s+(\d+)\b/g)].map((m) => ({ repo: m[1], pr: Number(m[2]) })))
      } else if (c.type === 'tool_result' && open.has(c.tool_use_id)) {
        const prs = open.get(c.tool_use_id)
        open.delete(c.tool_use_id)
        const result = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join('\n')
        const merged = (result.match(/^merged\s*$/gm) ?? []).length
        for (const p of prs.slice(0, merged)) out.push({ at: r.timestamp, kind: 'merge', ...p })
      }
    }
  }
  return out
}
