#!/usr/bin/env node
// Marks a key point no hook sees: `node mark.mjs <label> [k=v ...]`, appended to the session's event log as
// {kind: "mark", label, ...}. Use it sparingly: a mark that changes no decision is not worth taking.

import { basename } from 'node:path'
import { write } from './event.mjs'

if (process.argv[1] && basename(process.argv[1]) === 'mark.mjs') {
  const [label, ...pairs] = process.argv.slice(2)
  if (!label) { console.error('usage: mark.mjs <label> [k=v ...]'); process.exit(2) }
  const path = write('mark', [`label=${label}`, ...pairs])
  console.log(path ? `marked ${label}` : `not marked: ${label} (events off or the log is not writable)`)
}
