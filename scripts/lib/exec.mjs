// The one place a child process is started. Everything else takes this as an
// argument, which is the seam tests use: a fake `run` records the argv it was
// given and returns a scripted result.
//
// Deliberately not mocked at the module level. `spawnSync` is not ours to
// mock -- if Node changes its behaviour a module mock keeps passing while the
// code breaks. This wrapper is ours, so it is the honest thing to substitute.
//
// PATH stubbing was measured and rejected: on Windows a `gh.cmd` stub is not
// executed by `spawnSync` with `shell: false`, and the call returns empty
// stdout with **no error**, so a test would read the silence as a real result.

import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function run(cmd, args, { cwd, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, cwd, maxBuffer })
  if (r.error?.code === 'ENOENT') {
    return { ok: false, missing: cmd, code: null, out: '', err: `${cmd} is not on PATH, or is a shim this cannot execute directly` }
  }
  return { ok: !r.error && r.status === 0, code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), raw: r.stdout ?? '' }
}

// A recording double. Give it a matcher list; it returns the first match and
// remembers every call so a test can assert on the argv that was built.
export function fakeRun(script = []) {
  const calls = []
  const fn = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, cwd: opts.cwd })
    const hit = script.find(s => s.cmd === cmd && (!s.match || s.match(args)))
    if (!hit) return { ok: false, code: 1, out: '', err: `fakeRun: no script entry for ${cmd} ${args.join(' ')}`, raw: '' }
    const r = typeof hit.result === 'function' ? hit.result(args) : hit.result
    return { ok: true, code: 0, out: '', err: '', raw: '', ...r }
  }
  fn.calls = calls
  return fn
}

// True when this module was run as the entry script rather than imported.
// Tests import; importing must never execute a main(). Comparing file URLs
// rather than paths sidesteps every separator and drive-letter difference.
export function isMain(metaUrl) {
  return process.argv[1] ? metaUrl === pathToFileURL(process.argv[1]).href : false
}
