#!/usr/bin/env node
// Prints the machine's limits as `heavy_slots heavy_agents light_agents cpus` on one line (what heavy.sh reads), or
// `--json`. The slot count comes from BATON_HEAVY_SLOTS, else from the limits file the dispatch hook writes from the
// project config (scripts/lib/machine.mjs), else from this machine's cpus and memory.

import { basename } from 'node:path'
import { limits, readMachineSection, readLimitsFile } from './lib/machine.mjs'

if (process.argv[1] && basename(process.argv[1]) === 'machine.mjs') {
  const l = limits({ config: { ...readMachineSection(), ...readLimitsFile() } })
  console.log(process.argv.includes('--json') ? JSON.stringify(l) : `${l.heavy_slots} ${l.heavy_agents} ${l.light_agents} ${l.cpus}`)
}
