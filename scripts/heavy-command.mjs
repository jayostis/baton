#!/usr/bin/env node
// PreToolUse hook on Bash and PowerShell, in an epic only: refuses a test runner or build that is not run through
// scripts/heavy.sh, and says the command to run instead. Four or five agents running test suites at once locked a
// 4-core machine into a restart; heavy.sh holds them to the slots the machine has. The patterns are
// `machine.heavy_commands` in the project config, else the defaults in scripts/lib/machine.mjs. The hook fires for a
// subagent's calls as it does for the session's. BATON_MACHINE=0 turns it off.
//
// Exit 0 lets the command through; exit 2 blocks it and its stderr goes back to the agent as the reason.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inEpic } from './epic-mode.mjs'
import { limits, readMachineSection, machineOff } from './lib/machine.mjs'
import { heavyCommands } from './lib/heavy-match.mjs'

export const HEAVY_SH = fileURLToPath(new URL('./heavy.sh', import.meta.url)).replace(/\\/g, '/')

export function verdict(input, { env = process.env, epic = inEpic(input.session_id, env), patterns = limits({ env }).heavy_commands, heavySh = HEAVY_SH } = {}) {
  const command = input.tool_input?.command
  if (!['Bash', 'PowerShell'].includes(input.tool_name) || typeof command !== 'string' || machineOff(env) || !epic) return { block: false }
  const { found, rewritten } = heavyCommands(command, patterns, heavySh)
  if (!found.length) return { block: false }
  return {
    block: true,
    reason: `Not run: ${found.map((f) => f.pattern).join(', ')} is a heavy local command and runs only through heavy.sh, which holds the machine to its slots. Run exactly:\n${rewritten}`,
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'heavy-command.mjs') {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { process.exit(0) }
  let result = { block: false }
  try { result = verdict(input, { patterns: limits({ config: readMachineSection(process.env, input.cwd) }).heavy_commands }) } catch {}
  if (result.block) {
    console.error(result.reason)
    process.exit(2)
  }
}
