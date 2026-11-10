#!/usr/bin/env node
// Prints the machine's limits: `heavy_slots heavy_agents light_agents cpus` on one line (what heavy.sh reads), or
// `--json` with the heavy-command patterns too. They come from the project config's `machine` section, else from this
// machine's cpus and memory (scripts/lib/machine.mjs).

import { basename } from 'node:path'
import { limits, readMachineSection } from './lib/machine.mjs'

if (process.argv[1] && basename(process.argv[1]) === 'machine.mjs') {
  const l = limits({ config: readMachineSection() })
  console.log(process.argv.includes('--json') ? JSON.stringify(l) : `${l.heavy_slots} ${l.heavy_agents} ${l.light_agents} ${l.cpus}`)
}
