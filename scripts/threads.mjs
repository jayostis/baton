#!/usr/bin/env node
// The mechanics of working a PR's review threads. Judgment stays with the
// caller: whether an outdated finding still holds, what the fix is, what the
// reply says. Everything here has one right answer.
//
//   list     --pr N              unresolved threads + review summary bodies, as JSON
//   reply    --pr N --thread ID --body-file F
//   resolve  --pr N --thread ID
//   check    --pr N              on the head branch? every thread answered? pushed?
//
// Exit codes are the contract:
//   0  ok
//   2  preflight   not a repo, not authenticated, PR unreachable, bad args
//   3  mismatch    the checkout is not on the PR's head branch
//   4  incomplete  threads in scope have no reply, or work is unpushed

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { appendRun } from './lib/runlog.mjs'

const EXIT = { OK: 0, PREFLIGHT: 2, MISMATCH: 3, INCOMPLETE: 4 }

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, cwd, maxBuffer: 64 * 1024 * 1024 })
  if (r.error?.code === 'ENOENT') return { ok: false, out: '', err: `${cmd} is not on PATH` }
  return { ok: !r.error && r.status === 0, code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

const THREADS_Q = `query($owner:String!,$name:String!,$pr:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$pr){
    reviewThreads(first:100){ nodes{
      id isResolved isOutdated path line originalLine
      comments(first:20){ nodes{ author{login} body createdAt } } } } } } }`

// Variables, never interpolation. A reply body carries backticks, quotes and
// newlines -- pasting one into a query string is how a well-argued reply
// becomes a syntax error, or worse, silently changes the mutation.
const REPLY_M = `mutation($id:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id, body:$body}){ comment{ url } } }`
const RESOLVE_M = `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`

function parseArgs(argv) {
  const out = { cmd: argv[0], pr: null, thread: null, body: null, bodyFile: null, dir: process.cwd(), json: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--pr') out.pr = argv[++i]
    else if (a === '--thread') out.thread = argv[++i]
    else if (a === '--body') out.body = argv[++i]
    else if (a === '--body-file') out.bodyFile = argv[++i]
    else if (a === '--dir') out.dir = argv[++i]
    else if (a === '--json') out.json = true
    else return { error: `unrecognised argument: ${a}` }
  }
  if (!['list', 'reply', 'resolve', 'check'].includes(out.cmd)) return { error: `unknown command: ${out.cmd ?? '(none)'}` }
  if (!out.pr || !/^\d+$/.test(String(out.pr))) return { error: 'missing or non-numeric --pr <number>' }
  if ((out.cmd === 'reply' || out.cmd === 'resolve') && !out.thread) return { error: `${out.cmd} needs --thread <id>` }
  if (out.cmd === 'reply' && !out.body && !out.bodyFile) return { error: 'reply needs --body or --body-file' }
  return out
}

function repoOf(dir) {
  const r = sh('gh', ['repo', 'view', '--json', 'owner,name', '--jq', '[.owner.login,.name] | @tsv'], dir)
  if (!r.ok) return null
  const [owner, name] = r.out.split('\t')
  return owner && name ? { owner, name } : null
}

function fetchThreads(repo, pr, dir) {
  const r = sh('gh', ['api', 'graphql', '-F', `owner=${repo.owner}`, '-F', `name=${repo.name}`,
    '-F', `pr=${pr}`, '-f', `query=${THREADS_Q}`], dir)
  if (!r.ok) return { error: r.err }
  try {
    const nodes = JSON.parse(r.out).data.repository.pullRequest.reviewThreads.nodes
    return { threads: nodes }
  } catch (e) { return { error: `unparseable thread response: ${e.message}` } }
}

function reviewBodies(repo, pr, dir) {
  const r = sh('gh', ['api', `repos/${repo.owner}/${repo.name}/pulls/${pr}/reviews`,
    '--jq', '[.[] | select(.body != "") | {user: .user.login, body: .body}]'], dir)
  if (!r.ok) return []
  try { return JSON.parse(r.out) } catch { return [] }
}

function main() {
  const o = parseArgs(process.argv.slice(2))
  if (o.error) {
    console.error(`threads: ${o.error}`)
    console.error('usage: threads.mjs <list|reply|resolve|check> --pr <n> [--thread <id>] [--body-file <f>] [--dir <repo>] [--json]')
    return EXIT.PREFLIGHT
  }

  const repo = repoOf(o.dir)
  if (!repo) return out(o, { outcome: 'preflight', reason: `${o.dir} is not a checkout of a GitHub repository` }, EXIT.PREFLIGHT)
  const slug = `${repo.owner}/${repo.name}`

  if (o.cmd === 'reply') {
    const body = o.bodyFile ? readFileSync(o.bodyFile, 'utf8') : o.body
    if (!body.trim()) return out(o, { repo: slug, outcome: 'preflight', reason: 'refusing to post an empty reply' }, EXIT.PREFLIGHT)
    const r = sh('gh', ['api', 'graphql', '-F', `id=${o.thread}`, '-F', `body=${body}`, '-f', `query=${REPLY_M}`], o.dir)
    if (!r.ok) return out(o, { repo: slug, outcome: 'preflight', reason: 'reply failed', detail: r.err }, EXIT.PREFLIGHT)
    return out(o, { repo: slug, pr: o.pr, thread: o.thread, outcome: 'ok', reason: 'reply posted', detail: r.out }, EXIT.OK)
  }

  if (o.cmd === 'resolve') {
    // Resolving is a claim that the fix is on the head SHA. It is the caller's
    // job to have pushed first; this refuses only what it can see.
    const r = sh('gh', ['api', 'graphql', '-F', `id=${o.thread}`, '-f', `query=${RESOLVE_M}`], o.dir)
    if (!r.ok) return out(o, { repo: slug, outcome: 'preflight', reason: 'resolve failed', detail: r.err }, EXIT.PREFLIGHT)
    return out(o, { repo: slug, pr: o.pr, thread: o.thread, outcome: 'ok', reason: 'thread resolved' }, EXIT.OK)
  }

  const got = fetchThreads(repo, o.pr, o.dir)
  if (got.error) return out(o, { repo: slug, outcome: 'preflight', reason: 'could not read review threads', detail: got.error }, EXIT.PREFLIGHT)

  const unresolved = got.threads.filter(t => !t.isResolved)
  const shaped = unresolved.map(t => ({
    id: t.id,
    path: t.path,
    // An outdated thread has line: null; originalLine is the only pointer to
    // where it was raised, and the flag says nothing about whether it holds.
    line: t.line ?? t.originalLine ?? null,
    outdated: t.isOutdated,
    comments: t.comments.nodes.map(c => ({ author: c.author?.login ?? null, body: c.body })),
  }))

  if (o.cmd === 'list') {
    return out(o, {
      repo: slug, pr: o.pr, outcome: 'ok',
      reason: `${shaped.length} unresolved thread(s), ${shaped.filter(t => t.outdated).length} outdated`,
      threads: shaped, summaryBodies: reviewBodies(repo, o.pr, o.dir),
    }, EXIT.OK)
  }

  // check
  const headRef = sh('gh', ['pr', 'view', o.pr, '--json', 'headRefName', '--jq', '.headRefName'], o.dir).out
  const onBranch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], o.dir).out
  const me = sh('gh', ['api', 'user', '--jq', '.login'], o.dir).out
  const dirty = sh('git', ['status', '--porcelain'], o.dir).out
  const unpushed = sh('git', ['rev-list', '--count', `origin/${onBranch}..HEAD`], o.dir)

  // Every thread in scope must carry a reply from you. This is the claim the
  // report makes; making it true is cheaper than asking anyone to count.
  const unanswered = shaped.filter(t => !t.comments.slice(1).some(c => c.author === me))

  const base = {
    repo: slug, pr: o.pr, headRef, onBranch, me,
    unresolved: shaped.length, unanswered: unanswered.length,
    unansweredIds: unanswered.map(t => `${t.path}:${t.line ?? '?'}`),
    dirty: dirty ? dirty.split(/\r?\n/).length : 0,
    unpushed: unpushed.ok ? Number(unpushed.out) : null,
  }

  if (headRef && onBranch && headRef !== onBranch) {
    return out(o, { ...base, outcome: 'mismatch', reason: `checkout is on ${onBranch}, the PR's head is ${headRef} — push nothing, resolve nothing` }, EXIT.MISMATCH)
  }
  if (base.unpushed > 0) {
    return out(o, { ...base, outcome: 'incomplete', reason: `${base.unpushed} commit(s) not on origin — resolving now would close threads over nothing` }, EXIT.INCOMPLETE)
  }
  if (unanswered.length > 0) {
    return out(o, { ...base, outcome: 'incomplete', reason: `${unanswered.length} of ${shaped.length} unresolved thread(s) have no reply from ${me}` }, EXIT.INCOMPLETE)
  }
  return out(o, { ...base, outcome: 'ok', reason: `on ${headRef}, nothing unpushed, every unresolved thread answered` }, EXIT.OK)
}

function out(o, d, code) {
  const logged = appendRun('threads', d.repo, { cmd: o.cmd, ...d, exit: code })
  if (o.json || o.cmd === 'list') { console.log(JSON.stringify({ ...d, exit: code, runLog: logged }, null, 2)); return code }
  const L = [`threads ${o.cmd}: ${d.outcome.toUpperCase()} — ${d.reason}`]
  if (d.unansweredIds?.length) L.push('  no reply: ' + d.unansweredIds.join(', '))
  if (d.detail) L.push('  ' + String(d.detail).split(/\r?\n/).join('\n  '))
  if (logged) L.push(`  logged: ${logged}`)
  console.log(L.join('\n'))
  return code
}

process.exitCode = main()
