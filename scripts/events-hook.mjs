#!/usr/bin/env node
// The epic's event log written by hooks, in an epic only (scripts/lib/events.mjs). One argument each:
//
//   dispatch   PreToolUse on Agent: description, role, weight, model, effort, step, subject. Logged whether or not the cap
//              then refuses it; only a dispatch that launched has a `launched` event.
//   launched   PostToolUse on Agent: the agent's id against the dispatch's tool_use_id.
//   handback   SubagentStop: the agent's id and description.
//
// It appends only, never blocks, and never fails the call it watches. BATON_EVENTS=0 turns it off.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { loadRoles } from './lib/roles.mjs'
import { keyOf, stepOf } from './lib/steps.mjs'
import { recordEvent } from './lib/events.mjs'
import { inEpic } from './epic-mode.mjs'

const metaDescription = (path) => { try { return JSON.parse(readFileSync(String(path).replace(/\.jsonl$/, '.meta.json'), 'utf8')).description || null } catch { return null } }

const agentIdOf = (response) => (response && typeof response === 'object' ? response.agentId ?? null : /agentId["':\s=]+([A-Za-z0-9_-]+)/.exec(String(response ?? ''))?.[1] ?? null)

// The event a hook's input makes, or null. Pure, so the tests need no file.
export function eventOf(mode, input, roles = loadRoles()) {
  if (mode === 'dispatch' && input.tool_name === 'Agent') {
    const t = input.tool_input || {}
    const description = String(t.description || '').trim()
    const key = keyOf(description)
    const role = Object.hasOwn(roles.roles, key) ? roles.roles[key] : null
    const weight = (role ? role.local : roles.defaultLocal?.[key]) === 'heavy' ? 'heavy' : 'light'
    return { kind: 'dispatch', fields: { tool_use_id: input.tool_use_id ?? null, description, role: role ? key : null, weight, model: t.model ?? null, effort: t.effort ?? null, step: stepOf(description), subject: String(t.prompt || '').split('\n')[0].trim().slice(0, 160) } }
  }
  if (mode === 'launched' && input.tool_name === 'Agent') {
    const r = input.tool_response
    return { kind: 'launched', fields: { tool_use_id: input.tool_use_id ?? null, agent: agentIdOf(r), status: r && typeof r === 'object' ? r.status ?? null : null } }
  }
  if (mode === 'handback') {
    const description = input.agent_transcript_path ? metaDescription(input.agent_transcript_path) : null
    return { kind: 'handback', fields: { agent: input.agent_id ?? null, description, step: stepOf(description) } }
  }
  return null
}

if (process.argv[1] && basename(process.argv[1]) === 'events-hook.mjs') {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    if (inEpic(input.session_id)) {
      const e = eventOf(process.argv[2], input)
      if (e) recordEvent(input, e.kind, e.fields)
    }
  } catch {}
}
