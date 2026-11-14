#!/usr/bin/env node
// The jobs a pull request never runs but its base branch will, one line each, from workflow files on disk:
//
//   node main-only.mjs --base <branch> [--default <branch>] <workflow.yml>...
//
// gate.sh fetches the workflows at the PR's head and calls this. See scripts/lib/workflows.mjs for what counts.

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { isMain } from './lib/exec.mjs'
import { mainOnlyJobs } from './lib/workflows.mjs'

export function lines(paths, { base, defaultBranch = base }) {
  const files = []
  for (const p of paths) { try { files.push({ file: basename(p), text: readFileSync(p, 'utf8') }) } catch {} }
  return mainOnlyJobs(files, { base, defaultBranch }).map((j) => `${j.file}: ${j.id}${j.name && j.name !== j.id ? ` (${j.name})` : ''}`)
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
  const base = value('--base') || 'main'
  const paths = args.filter((a, i) => !a.startsWith('--') && !['--base', '--default'].includes(args[i - 1]))
  for (const line of lines(paths, { base, defaultBranch: value('--default') || base })) console.log(line)
}
