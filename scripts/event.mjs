#!/usr/bin/env node
// Appends one event to the epic's event log: `node event.mjs <kind> [k=v ...] [--busy]`. How heavy.sh, wait-ci.sh and
// gate.sh write theirs (scripts/lib/events.sh), and what mark.mjs wraps. `--busy` also prints the machine's busy cpu time
// in ms, for the matching end event's busy_before=. It exits 0 whatever happens: recording never changes a verdict.

import { basename } from 'node:path'
import { appendEvent, scriptEventsPath, scriptRecord, machineBusyMs, eventsOff } from './lib/events.mjs'

export function write(kind, pairs, env = process.env, cwd = process.cwd()) {
  if (eventsOff(env)) return null
  const path = scriptEventsPath(env, cwd)
  return appendEvent(path, scriptRecord(kind, pairs, env, cwd)) ? path : null
}

if (process.argv[1] && basename(process.argv[1]) === 'event.mjs') {
  try {
    const args = process.argv.slice(2)
    const busy = args.includes('--busy')
    const [kind, ...pairs] = args.filter((a) => a !== '--busy')
    if (kind) write(kind, pairs)
    if (busy) console.log(machineBusyMs())
  } catch {}
}
