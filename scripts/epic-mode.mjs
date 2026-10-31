#!/usr/bin/env node
// Marks the current session as running an epic, which is what turns the model rule on.
//
//   node epic-mode.mjs on | off | status
//
// The marker is one empty file per session, <BATON home>/epic/<session id>, keyed by CLAUDE_CODE_SESSION_ID, which the
// hooks receive as session_id. BATON_EPIC=1 in the environment does the same for a session that cannot write the file.

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { batonHome } from './lib/runlog.mjs'

export const markerPath = (sessionId, home = batonHome()) => join(home, 'epic', String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_'))

export function inEpic(sessionId, env = process.env) {
  return env.BATON_EPIC === '1' || Boolean(sessionId && existsSync(markerPath(sessionId)))
}

if (process.argv[1] && basename(process.argv[1]) === 'epic-mode.mjs') {
  const verb = process.argv[2]
  const id = process.env.CLAUDE_CODE_SESSION_ID
  if (!['on', 'off', 'status'].includes(verb) || !id) {
    console.error(!id ? 'epic-mode: CLAUDE_CODE_SESSION_ID is not set; export BATON_EPIC=1 instead' : 'usage: epic-mode.mjs on|off|status')
    process.exit(2)
  }
  const path = markerPath(id)
  if (verb === 'on') { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '') }
  else if (verb === 'off') rmSync(path, { force: true })
  console.log(`epic mode ${existsSync(path) ? 'on' : 'off'} for session ${id}`)
}
