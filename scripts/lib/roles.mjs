// The role table and the cost weights, read from references/roles.json so a retro recalibrates data, not code.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const ROLES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'references', 'roles.json')

export function loadRoles(path = ROLES_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// Cost units of one agent's token counts: each kind's tokens times its weight, times the model's.
export function units(tokens, model, roles = loadRoles()) {
  const { kinds, models } = roles.weights
  const family = Object.keys(models).find((m) => m !== 'unknown' && String(model).includes(m)) || 'unknown'
  const base = (tokens.input || 0) * kinds.input + (tokens.cacheWrite || 0) * kinds.cacheWrite +
    (tokens.cacheRead || 0) * kinds.cacheRead + (tokens.output || 0) * kinds.output
  return Math.round(base * models[family])
}

// Units as the status line prints them: a percent of the week once the retro has set the calibration, else units.
export function show(unitCount, roles = loadRoles()) {
  const per = roles.calibration.unitsPerPercentOfWeek
  const n = unitCount >= 1e6 ? `${(unitCount / 1e6).toFixed(1)}M units` : `${Math.round(unitCount / 1e3)}k units`
  return per ? `${(unitCount / per).toFixed(1)}% of the week (${n})` : n
}
