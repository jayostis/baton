#!/usr/bin/env node
// Runs a PR review and proves whether it happened.
//
// The reviewer is a subprocess that can succeed at running while failing at
// reviewing: denied a tool, unable to post, or pointed at the wrong repository
// entirely. It exits 0 in every one of those cases. This script is what looks.
//
// Exit codes are the contract:
//   0  clean      ran, nothing denied, no findings
//   1  findings   ran, findings posted as threads
//   2  preflight  never started: no auth, no repo, no PR, wrong directory
//   3  denied     ran, tool calls were denied, findings may be recoverable
//   4  unproven   ran, but what it produced and what the PR holds disagree
//   5  inspected  --dry-run or --no-post: nothing was posted, nothing is proven

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { appendRun as writeRun } from './lib/runlog.mjs'

const EXIT = { CLEAN: 0, FINDINGS: 1, PREFLIGHT: 2, DENIED: 3, UNPROVEN: 4, INSPECTED: 5 }
const LEVELS = ['low', 'medium', 'high', 'max']

// argv arrays only, shell never. A command is never a string, so nothing parses
// one: no quoting rules, no `&&`, no `$(...)`, nothing to differ by platform.
//
// There is deliberately no `shell: true` fallback for a missing executable.
// Node concatenates argv unescaped under that option -- it warns as much -- so
// the retry that was here mangled every argument containing a space or a pipe,
// which is all of them. A clear failure beats a silently corrupted command.
function run(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: false,
    cwd,
    maxBuffer: 64 * 1024 * 1024, // a review envelope blows the 1 MiB default
  })
  if (r.error?.code === 'ENOENT') {
    return { ok: false, missing: cmd, code: null, stdout: '', stderr: `${cmd} is not on PATH, or is a shim this cannot execute directly` }
  }
  return { ok: !r.error && r.status === 0, code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

// A failed write must never change the verdict of the run it is recording.
function appendRun(opts, d) {
  if (opts.noLog || opts.dryRun) return null
  return writeRun('pr-review', d.repo ?? opts.repo, {
    outcome: d.outcome, exit: EXIT[String(d.outcome).toUpperCase()] ?? null, reason: d.reason ?? null,
    pr: d.pr ?? opts.pr, head: d.head ?? null, dir: d.dir ?? opts.dir,
    levelAsked: d.levelAsked ?? opts.level, levelSeen: d.levelSeen ?? null,
    denials: d.denials ?? null, deniedTools: d.deniedTools ?? null, recovered: d.recovered?.length ?? null,
    threadsBefore: d.threadsBefore ?? null, threadsAdded: d.threadsAdded ?? null, claimed: d.claimed ?? null,
    elapsedMs: d.elapsedMs ?? null, costUsd: d.costUsd ?? null, usage: d.usage ?? null, noPost: opts.noPost,
    // Truncated on purpose: evidence for an audit, not an archive. --save keeps
    // the whole envelope when a run is worth preserving in full.
    resultExcerpt: typeof d.result === 'string' ? d.result.slice(0, 4000) : null,
  })
}

function parseArgs(argv) {
  const out = { pr: null, level: null, repo: null, dir: process.cwd(), json: false, dryRun: false, noPost: false, noLog: false, save: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--pr') out.pr = argv[++i]
    else if (a === '--level') out.level = argv[++i]
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--dir') out.dir = argv[++i]
    else if (a === '--save') out.save = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--no-post') out.noPost = true
    else if (a === '--no-log') out.noLog = true
    else return { error: `unrecognised argument: ${a}` }
  }
  if (!out.pr) return { error: 'missing --pr <number>' }
  if (!/^\d+$/.test(out.pr)) return { error: `--pr must be a number, got ${out.pr}` }
  if (!out.level) return { error: `missing --level <${LEVELS.join('|')}>` }
  if (!LEVELS.includes(out.level)) return { error: `--level must be one of ${LEVELS.join(', ')}, got ${out.level}` }
  return out
}

function threadIds(repo, pr, cwd) {
  const r = run('gh', ['api', '--paginate', `repos/${repo}/pulls/${pr}/comments`,
    '--jq', '.[] | select(.in_reply_to_id == null) | .id'], { cwd })
  if (!r.ok) return null
  return new Set(r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean))
}

// The reviewer resolves a bare PR number against its own working directory, so
// the directory IS the target. --repo does not redirect it; it asserts what the
// directory had better be. Getting this wrong reviews someone else's code and
// reports clean, which is what the first run of this script did.
function preflight(opts) {
  const auth = run('gh', ['auth', 'status'], { cwd: opts.dir })
  if (!auth.ok) return { failed: auth.missing ? auth.stderr : 'gh is not authenticated', detail: auth.stderr.trim() }

  const r = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: opts.dir })
  if (!r.ok) return { failed: `${opts.dir} is not a checkout of a GitHub repository`, detail: r.stderr.trim() }
  const repo = r.stdout.trim()

  if (opts.repo && opts.repo !== repo) {
    return {
      failed: `--repo says ${opts.repo} but ${opts.dir} is a checkout of ${repo}`,
      detail: 'the reviewer resolves the PR number against its working directory, so run this from a checkout of the repo you mean, or pass --dir',
    }
  }

  const pr = run('gh', ['pr', 'view', opts.pr, '--json', 'headRefOid,url,state,title',
    '--jq', '[.headRefOid, .url, .state, .title] | @tsv'], { cwd: opts.dir })
  if (!pr.ok) return { failed: `PR #${opts.pr} is not reachable in ${repo}`, detail: pr.stderr.trim() }

  const [head, url, state, title] = pr.stdout.trim().split('\t')
  return { repo, head, url, state, title }
}

// A denied post carries the finding it was trying to make, verbatim, in the
// command it was blocked from running -- the only place a finding survives when
// posting fails. It holds only the posts that were attempted, and a reviewer
// denied once tends to stop trying, so it is a floor and never a count.
function recoverFindings(denials) {
  const out = []
  for (const d of denials) {
    const input = d?.tool_input ?? {}
    const text = [input.command, input.body, input.script].filter(v => typeof v === 'string').join('\n')
    if (!text || !/pulls\/\d+\/comments|create_inline_comment|reviews?\b/i.test(text)) continue
    out.push({ tool: d.tool_name ?? 'unknown', text: text.trim() })
  }
  return out
}

// Best-effort only: the envelope carries no field naming the level that ran, so
// the reviewer's prose is the only tell and absence proves nothing.
function levelSeenIn(result) {
  const m = result.match(/effort level[^\n]*?\b(low|medium|high|max)\b/i) ||
            result.match(/\breusing\b[^\n]*?\b(low|medium|high|max)\b/i)
  return m ? m[1].toLowerCase() : null
}

function claimedFindings(result) {
  const m = result.match(/\b(\d+)\s+findings?\b/i) || result.match(/\bfindings?\s*\((\d+)\)/i)
  return m ? Number(m[1]) : null
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.error) {
    console.error(`pr-review: ${opts.error}`)
    console.error(`usage: pr-review.mjs --pr <n> --level <${LEVELS.join('|')}> [--dir <checkout>] [--repo owner/name]`)
    console.error('       [--no-post] [--dry-run] [--json] [--save <file>] [--no-log]')
    return EXIT.PREFLIGHT
  }

  const pre = preflight(opts)
  if (pre.failed) { report(opts, { outcome: 'preflight', reason: pre.failed, detail: pre.detail }); return EXIT.PREFLIGHT }
  if (pre.state !== 'OPEN') { report(opts, { outcome: 'preflight', reason: `PR #${opts.pr} is ${pre.state}, not open` }); return EXIT.PREFLIGHT }

  const before = threadIds(pre.repo, opts.pr, opts.dir)
  if (before === null) { report(opts, { outcome: 'preflight', reason: 'could not read existing review threads' }); return EXIT.PREFLIGHT }

  // The level goes first. Claude Code reads the level, then the flags, and
  // everything left on the line is the review target -- so a level after the
  // target is swallowed into it and the run reuses the last level typed.
  const prompt = opts.noPost
    ? `/code-review ${opts.level} ${opts.pr}`
    : `/code-review ${opts.level} ${opts.pr} --comment`

  const claudeArgs = [
    '-p', prompt,
    '--output-format', 'json',
    '--permission-mode', 'dontAsk',
    // Bare tool names. A prefix pattern matches a command string and the
    // reviewer composes shell, so `Bash(gh api:*)` never matches
    // `SHA=$(gh pr view ...) && gh api ...`; and on Windows it reaches for
    // PowerShell, which no Bash(...) rule can name at all.
    '--allowedTools', 'Read', 'Grep', 'Glob', 'Bash', 'PowerShell',
    // Deny rules are evaluated before the permission mode and before any allow
    // rule, so these hold. This verb changes no files.
    '--disallowedTools', 'Write', 'Edit', 'NotebookEdit',
  ]

  const base = { pr: opts.pr, repo: pre.repo, head: pre.head, url: pre.url, title: pre.title, levelAsked: opts.level, dir: opts.dir }

  if (opts.dryRun) {
    report(opts, { ...base, outcome: 'inspected', reason: 'dry run: nothing was spawned', argv: ['claude', ...claudeArgs] })
    return EXIT.INSPECTED
  }

  const started = Date.now()
  const proc = run('claude', claudeArgs, { cwd: opts.dir })
  const elapsedMs = Date.now() - started

  if (proc.missing) { report(opts, { ...base, outcome: 'preflight', reason: proc.stderr }); return EXIT.PREFLIGHT }

  let envelope
  try { envelope = JSON.parse(proc.stdout) } catch {
    report(opts, { ...base, outcome: 'unproven', reason: 'the reviewer produced no parseable JSON envelope', detail: (proc.stderr || proc.stdout).slice(0, 800), exitCode: proc.code })
    return EXIT.UNPROVEN
  }
  if (opts.save) writeFileSync(opts.save, JSON.stringify(envelope, null, 2))

  const denials = Array.isArray(envelope.permission_denials) ? envelope.permission_denials : []
  const after = threadIds(pre.repo, opts.pr, opts.dir)
  const added = after === null ? null : [...after].filter(id => !before.has(id))
  const result = typeof envelope.result === 'string' ? envelope.result : ''

  Object.assign(base, {
    elapsedMs, exitCode: proc.code,
    isError: envelope.is_error ?? null, subtype: envelope.subtype ?? null,
    denials: denials.length,
    threadsBefore: before.size, threadsAdded: added === null ? null : added.length,
    levelSeen: levelSeenIn(result), claimed: claimedFindings(result),
    costUsd: envelope.total_cost_usd ?? null, usage: envelope.usage ?? null,
    result,
  })

  // The exit code proves nothing: a session that explains why it could not
  // proceed has succeeded by its own lights. The ledger is the only record.
  if (denials.length > 0) {
    report(opts, { ...base, outcome: 'denied', reason: `${denials.length} tool call(s) denied; the review could not deliver`,
      deniedTools: [...new Set(denials.map(d => d?.tool_name ?? 'unknown'))], recovered: recoverFindings(denials) })
    return EXIT.DENIED
  }
  if (!proc.ok) { report(opts, { ...base, outcome: 'unproven', reason: `the reviewer exited ${proc.code}` }); return EXIT.UNPROVEN }
  if (added === null) { report(opts, { ...base, outcome: 'unproven', reason: 'could not re-read threads after the run' }); return EXIT.UNPROVEN }

  // --no-post cannot post, so thread accounting says nothing about it. Anything
  // it reports is a diagnostic, never a verdict, and it gets its own exit code
  // so no caller can read it as a completed review.
  if (opts.noPost) {
    report(opts, { ...base, outcome: 'inspected', reason: `no-post run: ${base.claimed ?? 'an unstated number of'} finding(s) reported, none posted by design` })
    return EXIT.INSPECTED
  }

  if (base.levelSeen && base.levelSeen !== opts.level) {
    report(opts, { ...base, outcome: 'unproven', reason: `asked for ${opts.level}, the reviewer reports running at ${base.levelSeen}` })
    return EXIT.UNPROVEN
  }
  if (added.length > 0) { report(opts, { ...base, outcome: 'findings', reason: `${added.length} finding(s) posted as threads` }); return EXIT.FINDINGS }
  if (base.claimed > 0) {
    report(opts, { ...base, outcome: 'unproven', reason: `the reviewer reports ${base.claimed} finding(s) and the PR holds none` })
    return EXIT.UNPROVEN
  }
  report(opts, { ...base, outcome: 'clean', reason: 'ran, nothing denied, no findings posted' })
  return EXIT.CLEAN
}

function report(opts, d) {
  const logged = appendRun(opts, d)
  if (opts.json) { console.log(JSON.stringify({ ...d, runLog: logged }, null, 2)); return }
  const L = [`pr-review: ${d.outcome.toUpperCase()} — ${d.reason}`]
  if (d.repo) L.push(`  ${d.repo}#${d.pr} "${d.title ?? ''}"  head ${String(d.head).slice(0, 8)}`)
  if (d.dir) L.push(`  cwd ${d.dir}  asked ${d.levelAsked}${d.levelSeen ? `  reported ${d.levelSeen}` : ''}`)
  if (d.detail) L.push(`  detail: ${d.detail}`)
  if (d.argv) L.push('  ' + d.argv.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '))
  if (d.denials !== undefined) L.push(`  denials ${d.denials}${d.deniedTools ? ` (${d.deniedTools.join(', ')})` : ''}  threads +${d.threadsAdded ?? '?'}  claimed ${d.claimed ?? '?'}  exit ${d.exitCode}  $${d.costUsd ?? '?'}`)
  if (d.recovered?.length) {
    L.push(`  recovered ${d.recovered.length} attempted post(s). ONLY ATTEMPTED POSTS ARE HERE —`)
    L.push('  a reviewer denied once stops trying, so this is a floor, not a count.')
    for (const r of d.recovered) L.push(`  --- via ${r.tool} ---\n${r.text}`)
  }
  if (logged) L.push(`  logged: ${logged}`)
  if (d.result) L.push('  reviewer said:\n' + d.result.split(/\r?\n/).map(l => '    ' + l).join('\n'))
  console.log(L.join('\n'))
}

// process.exit() can truncate unflushed stdout on a pipe, and the DENIED path
// prints the only surviving copy of the findings.
process.exitCode = main()
