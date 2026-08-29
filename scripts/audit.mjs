#!/usr/bin/env node
// STUB. Written by the tests, not by the implementation.
//
// Its only job is to make `test/audit.test.mjs` fail on its assertions rather
// than on a missing module — every test in that file is red against this file
// by design. It reads no log, classifies nothing, queries nothing and redacts
// nothing.
//
// The contract the tests pin, and all they pin:
//   main(argv, { run }) -> exit code, printing one JSON object on --json
//   argv:   --runs <dir of *.jsonl>  --repo <owner/name>  --json
//   stdout: { candidates: [ { fingerprint, count, ... } ], skipped: <n> }
// Everything else — how a record is classified, what a fingerprint is made of,
// how a candidate is worded, where a no-action disposition is recorded — is
// the implementer's to decide.

import { isMain } from './lib/exec.mjs'

export function main(argv = process.argv.slice(2), deps = {}) {
  const report = { candidates: [], skipped: 0 }
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main()
