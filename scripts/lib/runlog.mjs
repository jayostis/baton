// One append-only stream per repository, written by every baton script without
// being asked. An audit that reads only what someone remembered to save reports
// impressions; one that reads a log reports facts. Draining it is the auditor's
// job, not this file's -- a log nobody dispositions is how a friction log dies.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// A finding has to say which baton produced it, so every new record carries the
// plugin version. Additive on purpose: `schema` stays 1 and every reader must
// tolerate the field's absence, because 30 records already lack it.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version ?? null
  } catch { return null }
})()

// Read at call time, never at load: a test sets BATON_HOME before importing the
// script under test, and a value frozen at import would point at the real log.
//
// CLAUDE_PLUGIN_DATA is deliberately still in this chain and deliberately not
// relied on -- it is exported to hook, MCP and LSP subprocesses only, so it is
// unset for a script a skill runs, and would split the log in two if a hook ever
// ran one. That is its own issue; the auditor must not paper over it.
export function batonHome() {
  return process.env.BATON_HOME || process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'baton')
}

export function runsDir() {
  const dir = join(batonHome(), 'runs')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function runLogPath(repo) {
  return join(runsDir(), `${String(repo || 'unknown').replace(/[^A-Za-z0-9._-]/g, '__')}.jsonl`)
}

// A failed write must never change the verdict of the run it is recording.
export function appendRun(tool, repo, record) {
  try {
    const path = runLogPath(repo)
    appendFileSync(path, JSON.stringify({
      schema: 1, ...(VERSION ? { version: VERSION } : {}), tool, ts: new Date().toISOString(), repo, ...record,
    }) + '\n')
    return path
  } catch {
    return null
  }
}
