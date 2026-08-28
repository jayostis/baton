// One append-only stream per repository, written by every baton script without
// being asked. An audit that reads only what someone remembered to save reports
// impressions; one that reads a log reports facts. Draining it is the auditor's
// job, not this file's -- a log nobody dispositions is how a friction log dies.

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function runLogPath(repo) {
  const base = process.env.BATON_HOME || process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'baton')
  const dir = join(base, 'runs')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${String(repo || 'unknown').replace(/[^A-Za-z0-9._-]/g, '__')}.jsonl`)
}

// A failed write must never change the verdict of the run it is recording.
export function appendRun(tool, repo, record) {
  try {
    const path = runLogPath(repo)
    appendFileSync(path, JSON.stringify({ schema: 1, tool, ts: new Date().toISOString(), repo, ...record }) + '\n')
    return path
  } catch {
    return null
  }
}
