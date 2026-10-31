// What one agent cost, read from its transcript. Every turn re-reads the agent's whole context, so the bill is turns
// times context, and the number that predicts the next turn's cost is the context of the last one. An agent's own
// handback reports neither; the transcript is the only witness.

import { readFileSync, existsSync } from 'node:fs'

export function contextOf(usage) {
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
}

// A response streamed in several records repeats its usage on each; count it once, by message id.
export function summarize(path) {
  const out = { turns: 0, models: {}, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, peakContext: 0, lastContext: 0, first: null, last: null, prompt: '' }
  if (!existsSync(path)) return null
  const seen = new Set()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.timestamp) { out.first ??= record.timestamp; out.last = record.timestamp }
    if (!out.prompt && record.type === 'user' && typeof record.message?.content === 'string') out.prompt = record.message.content
    const usage = record.message?.usage
    if (record.type !== 'assistant' || !usage) continue
    const id = record.message.id
    if (id) { if (seen.has(id)) continue; seen.add(id) }
    const model = record.message.model || 'unknown'
    if (model === '<synthetic>') continue
    out.turns += 1
    out.models[model] = (out.models[model] || 0) + 1
    out.input += usage.input_tokens || 0
    out.output += usage.output_tokens || 0
    out.cacheRead += usage.cache_read_input_tokens || 0
    out.cacheWrite += usage.cache_creation_input_tokens || 0
    out.lastContext = contextOf(usage)
    out.peakContext = Math.max(out.peakContext, out.lastContext)
  }
  return out
}

export function mainModel(summary) {
  return Object.entries(summary.models).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown'
}

// Has the agent handed back? Its last response ended the turn or called SubagentHandback, and nothing but tool
// results has arrived since. A message sent after that resumes it from its whole transcript.
export function isFinished(path) {
  if (!existsSync(path)) return false
  let last = null
  let resumed = false
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.type === 'assistant' && record.message?.model !== '<synthetic>') { last = record; resumed = false }
    else if (last && record.type === 'user') {
      const content = record.message?.content
      if (typeof content === 'string' || (Array.isArray(content) && content.some((c) => c.type !== 'tool_result'))) resumed = true
    }
  }
  if (!last || resumed) return false
  const content = Array.isArray(last.message?.content) ? last.message.content : []
  return content.some((c) => c.type === 'tool_use' && c.name === 'SubagentHandback') ||
    last.message?.stop_reason === 'end_turn' || last.message?.stop_reason === 'stop_sequence'
}
