#!/usr/bin/env node
// Reads the run log nobody reads.
//
// Three scripts append a record on every run, in every project baton is used
// in. That is the only durable record of baton failing somewhere other than
// here -- a session-scoped tool sees one session and accumulates nothing. This
// is the drain: it turns those records into deduplicated candidates a skill can
// draft from. It classifies; it never files, labels, closes or comments.
//
// Two properties of the real log are load-bearing and are why this is written
// the way it is:
//
//   - **One record predates the `tool` field**, and it is one of three
//     otherwise-identical PREFLIGHT records. Nothing that groups records may key
//     on `tool`, or that group splits into 2 + 1 and one repeated fact reads as
//     two facts.
//   - **Appends are concurrent** -- ten records arrived from another session
//     while this was being specified -- so the last line of a file may be torn.
//     A parse failure is data about the log, not a reason to stop reading it.
//
// Exit codes are the contract:
//   0  ok         nothing to report
//   1  candidates something to draft
//   2  preflight  could not read, or could not dedupe -- see below on why not
//                 being able to dedupe is fatal rather than a degraded run

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { run as realRun, isMain } from './lib/exec.mjs'
import { batonHome, appendRun as writeRun } from './lib/runlog.mjs'

const EXIT = { OK: 0, CANDIDATES: 1, PREFLIGHT: 2 }

// A record whose schema this does not know cannot be read field by field, so it
// is skipped and counted rather than guessed at. An unknown *tool* is different:
// the envelope is still schema 1, so the record reads fine and the unknown name
// is itself the finding.
const SCHEMAS = new Set([1])

// The documented exit set per script -- the source is each script's header
// comment, which is the contract those scripts state. An exit outside its own
// set is either an undocumented path or a stale document; both are findings.
const EXITS = {
  'pr-review': [0, 1, 2, 3, 4, 5],
  threads: [0, 2, 3, 4],
  branch: [0, 2, 3, 4],
  audit: [0, 1, 2],
}

// ------------------------------------------------------------------ redaction
//
// This repository is public and the records carry other projects' paths, names
// and review output. Redaction is an allowlist, never a blocklist: evidence is
// rebuilt field by field from names spelled out here, so a field a future writer
// adds to the log cannot leak by default. Basename-only was considered and
// rejected -- the leaf of `C:\Users\Jay\dev\onc-secret` is the private part.

// Spaces are the norm in a Windows path (`Program Files`, `OneDrive - Org`),
// and a class that stops at the first one redacts the drive and leaks the leaf.
// So a segment may contain spaces -- but only a segment that is followed by a
// separator, because the alternative is that the match runs on through the
// prose after the path (`... is not a checkout of a GitHub repository`), which
// destroys the evidence and collapses distinct reasons into one key.
// Residual, deliberately: a FINAL segment containing a space still ends at that
// space, since nothing in the text distinguishes `\My App` from `\baton is`.
//
// `:` is excluded from a SPACED continuation, and only from there. A segment
// may still hold spaces, but a second drive letter can no longer be absorbed
// into one: `C:\a\alpha is not a checkout of C:\dev\one` matched end to end as
// a single path, so two unrelated refusals collapsed onto one key and reported
// as a recurrence -- the fabrication `minCount: 2` exists to prevent -- with
// the prose that distinguished them redacted away as evidence.
//
// A SPACED segment must be followed by the separator the drive letter used --
// captured once and backreferenced, not assumed. That is the difference
// between a folder name and a sentence. The reason this log carries three
// times over ends in a repository slug:
// `...\skills\baton is a checkout of jayostis/baton`, and the slash inside
// that slug was read as a separator, so the match ran from the drive letter to
// the end of the sentence and redacted away the pair of names the finding
// consisted of.
//
// Pinning the separator rather than hardcoding `\` is what keeps
// `C:/Users/Jay/My Secret Co/proj/x` whole. Requiring a backslash was tried
// first and measured: it ended that path at its first space and left `Secret`
// in the text -- a new leak, in a shape this repository writes constantly,
// since every `--dir` in these skills is spelled with forward slashes.
//
// Residual, measured: a forward-slash path followed by prose ending in a slug
// still swallows the sentence, exactly as the POSIX pattern below does. That
// over-redacts and does not leak, which is the direction to fail in.
const WIN_SEG = String.raw`[^\\/\s"',;)]+(?: +[^\\/\s"',;:)]+)*`
const WIN_PLAIN = String.raw`[^\\/\s"',;)]+`
const WIN_PATH = new RegExp(String.raw`[A-Za-z]:([\\/])(?:${WIN_SEG}\1|${WIN_PLAIN}[\\/])*[^\\/\s"',;)]*`, 'g')
// The same rule, for the same reason, on POSIX: `[\w.-]+` stopped at the first
// space, so `/home/jay/My Secret Co/proj/x` left `Secret` in the text and handed
// `Co/proj` to SLUG, which rewrote it as `<repo>` -- a leaked path fragment
// disguised as a redacted repository name. Not a Windows-only leak, and this
// repository is public. A continuation excludes `/` as well as `:`, which is
// what stops the match running on into the prose after the path.
const POSIX_SEG = String.raw`[\w.-]+(?: +[^\\/\s"',;:)]+)*`
const POSIX_PATH = new RegExp(String.raw`(^|[\s"'(=])(\/(?:${POSIX_SEG}\/)+[\w.-]+)`, 'g')
const SLUG = /\b[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+/g

function redact(text, self) {
  if (typeof text !== 'string') return text ?? null
  return text
    .replace(WIN_PATH, '<path>')
    .replace(POSIX_PATH, (_m, lead) => lead + '<path>')
    .replace(SLUG, s => (s === self ? s : '<repo>'))
}

// ------------------------------------------------------------------ reading

function readRecords(dir, since) {
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()
  const records = []
  let skipped = 0
  for (const f of files) {
    let text
    try { text = readFileSync(join(dir, f), 'utf8') } catch { skipped++; continue }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      let rec
      // A torn tail is expected, not exceptional: another session may be mid
      // append. Count it and keep reading the rest of the log.
      try { rec = JSON.parse(line) } catch { skipped++; continue }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { skipped++; continue }
      if (!SCHEMAS.has(rec.schema)) { skipped++; continue }
      if (since && typeof rec.ts === 'string' && rec.ts < since) continue
      records.push(rec)
    }
  }
  return { records, skipped, files: files.length }
}

// ------------------------------------------------------------------ rules
//
// Every rule is mechanical and the first one that matches wins: a record is
// filed under the one fact that best explains it, so eight records produce at
// most eight attributions and a count means what it says. `key` is what groups
// records into a candidate -- it never contains `tool`, because the tool-less
// record has to group with its two identical siblings, and never contains a
// timestamp, because a fingerprint has to survive to the next run to dedupe.

// Two different facts, and the writer records them separately: `denials` is the
// number of calls refused, `deniedTools` is that list de-duplicated by name. So
// `denials: 7, deniedTools: ["PowerShell"]` is one tool and seven refusals --
// reporting 1 as the count contradicts the log this is quoting. The guard only
// needs to know that something was refused; evidence needs the recorded number.
const denialCountOf = r => Number(r.denials) || 0
const wasDenied = r => denialCountOf(r) > 0 || (Array.isArray(r.deniedTools) && r.deniedTools.length > 0)

function classify(r, self) {
  const reason = redact(r.reason, self)
  const tools = Array.isArray(r.deniedTools) ? r.deniedTools.map(t => redact(String(t), self)).sort() : []

  if (wasDenied(r)) {
    return {
      kind: 'denied', key: ['denied', ...tools].join('|'),
      title: `a run was denied ${tools.length ? tools.join(', ') : 'a tool call'} and could not deliver`,
    }
  }

  // Both sides must be known. A preflight never reaches the reviewer, so its
  // levelSeen is null -- reading that as drift would file the guard working as
  // a defect, and would split the repeated preflight group besides.
  if (r.levelAsked && r.levelSeen && r.levelAsked !== r.levelSeen) {
    return {
      kind: 'level-drift', key: `level-drift|${r.levelAsked}->${r.levelSeen}`,
      title: `asked for ${r.levelAsked}, the reviewer reported running at ${r.levelSeen}`,
    }
  }

  // A run that could not post has nothing to say about what the PR holds:
  // `--no-post` and `--dry-run` both report `inspected`, and the first carries
  // `noPost: true`. Reading either as findings that went missing files the
  // guard working as a defect -- the same mistake the level-drift rule above
  // takes care to avoid.
  // And `threadsAdded: null` is "the threads could not be read", not "the PR
  // holds none" -- pr-review.mjs writes exactly that for its own
  // `could not re-read threads after the run` exit. `?? 0` read the absence of
  // a count as a count of zero and filed a PR nobody had looked at, which is
  // the same mistake again: asserting a fact the log does not contain. Strict,
  // so an unknown thread count classifies as nothing.
  const couldPost = r.noPost !== true && r.outcome !== 'inspected'
  if (couldPost && Number(r.claimed) > 0 && r.threadsAdded === 0) {
    return {
      kind: 'findings-unposted', key: 'findings-unposted',
      title: 'the reviewer claimed findings and the PR holds no threads',
    }
  }

  if (r.outcome === 'preflight' && reason) {
    return {
      kind: 'preflight-repeat', key: `preflight|${reason}`, minCount: 2,
      title: `a preflight refusal keeps recurring: ${reason}`,
    }
  }

  if (r.repo == null) {
    return {
      kind: 'repo-null', key: 'repo-null',
      title: 'a run recorded no repository, so its record cannot be attributed',
    }
  }

  if (r.tool != null && !Object.hasOwn(EXITS, r.tool)) {
    return {
      kind: 'unknown-tool', key: `unknown-tool|${r.tool}`,
      title: `the log carries a tool this reader does not know: ${r.tool}`,
    }
  }

  const documented = r.tool != null && Object.hasOwn(EXITS, r.tool) ? EXITS[r.tool] : null
  if (documented && Number.isInteger(r.exit) && !documented.includes(r.exit)) {
    return {
      kind: 'undocumented-exit', key: `undocumented-exit|${r.tool}|${r.exit}`,
      title: `${r.tool} exited ${r.exit}, which its documented set (${documented.join(', ')}) does not contain`,
    }
  }

  return null
}

const fingerprintOf = key => 'bf-' + createHash('sha256').update(key).digest('hex').slice(0, 16)

// Rebuilt field by field. No `dir`, no `resultExcerpt`, no repository name, no
// source filename -- each of those is the private part of somebody else's work.
function evidenceOf(r, self) {
  return {
    ts: r.ts ?? null,
    tool: r.tool ?? null,
    version: r.version ?? null,
    outcome: r.outcome ?? null,
    exit: Number.isInteger(r.exit) ? r.exit : null,
    where: r.repo == null ? 'unattributed' : r.repo === self ? 'this repository' : 'another project',
    levelAsked: r.levelAsked ?? null,
    levelSeen: r.levelSeen ?? null,
    denials: denialCountOf(r) || null,
    deniedTools: Array.isArray(r.deniedTools) ? r.deniedTools.map(t => redact(String(t), self)) : null,
    threadsAdded: r.threadsAdded ?? null,
    claimed: r.claimed ?? null,
    reason: redact(r.reason, self),
  }
}

function candidatesFrom(records, self) {
  const groups = new Map()
  for (const r of records) {
    const hit = classify(r, self)
    if (!hit) continue
    let g = groups.get(hit.key)
    if (!g) groups.set(hit.key, (g = { ...hit, records: [], repos: new Set(), tools: new Set() }))
    g.records.push(r)
    if (r.repo != null) g.repos.add(r.repo)
    if (r.tool != null) g.tools.add(r.tool)
  }

  const out = []
  for (const g of groups.values()) {
    // "An identical preflight reason *repeated*" -- a single refusal is the
    // guard doing its job, and raising it would be raising every correct stop.
    if (g.minCount && g.records.length < g.minCount) continue
    const ts = g.records.map(r => r.ts).filter(t => typeof t === 'string').sort()
    out.push({
      fingerprint: fingerprintOf(g.key),
      kind: g.kind,
      title: g.title,
      count: g.records.length,
      firstSeen: ts[0] ?? null,
      lastSeen: ts[ts.length - 1] ?? null,
      tools: [...g.tools].sort(),
      projects: g.repos.size,          // how many, never which
      evidence: g.records.slice(0, 5).map(r => evidenceOf(r, self)),
    })
  }
  // Deterministic, and independent of the order files happened to be read in:
  // the fingerprints a first run reports have to be the ones a second run drops.
  return out.sort((a, b) =>
    b.count - a.count ||
    String(b.lastSeen).localeCompare(String(a.lastSeen)) ||
    a.fingerprint.localeCompare(b.fingerprint))
}

// ------------------------------------------------------------------ dedupe
//
// In process, against every issue body, open and closed alike. Not GitHub's
// search index: a finding a run cannot see is a finding it files twice, and a
// closed issue is a decision already made -- raising it again is the duplicate.

function dispositioned() {
  const path = join(batonHome(), 'dispositions.jsonl')
  const seen = new Set()
  if (!existsSync(path)) return seen
  let text
  try { text = readFileSync(path, 'utf8') } catch { return seen }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line)
      if (d && typeof d.fingerprint === 'string') seen.add(d.fingerprint)
    } catch { /* a torn disposition drops one exclusion, never the run */ }
  }
  return seen
}

function issueBodies(run, repo, cwd) {
  // One query for the whole run. --state all because a closed issue counts, and
  // --limit because gh returns 30 by default and a silent truncation here files
  // duplicates of everything past the thirtieth.
  const r = run('gh', ['issue', 'list', '--repo', repo, '--state', 'all',
    '--json', 'number,state,title,body', '--limit', '500'], { cwd })
  if (!r.ok) return { error: r.err || `gh issue list failed for ${repo}` }
  try {
    const issues = JSON.parse(r.out || '[]')
    return { bodies: (Array.isArray(issues) ? issues : []).map(i => String(i?.body ?? '')) }
  } catch (e) {
    return { error: `unparseable issue list: ${e.message}` }
  }
}

// ------------------------------------------------------------------ cli

function parseArgs(argv) {
  const out = { runs: null, repo: null, since: null, dir: process.cwd(), json: false, noLog: false }
  // An unknown argument is refused, so a known one that silently loses its
  // value must be too: `--runs` at the end of the line set `runs` to undefined
  // and fell through to the operator's real log, auditing everything with no
  // diagnostic. A following flag is the same mistake, not a directory name.
  let bad = null
  const value = (flag, i) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) { bad ??= `${flag} requires a value`; return null }
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // `i` advances only when a value was actually taken. Advancing on failure
    // consumed the token that had just refused to be a value -- always another
    // flag -- and the loop's own `i++` then skipped it, so `--runs --no-log`
    // parsed neither: the refused run appended the record `--no-log` had asked
    // it not to write. `--runs --json` lost `--json` the same way and reported
    // on the human line, handing a caller unparseable output alongside exit 2.
    if (a === '--runs') { const v = value(a, i); if (v !== null) { out.runs = v; i++ } }
    else if (a === '--repo') { const v = value(a, i); if (v !== null) { out.repo = v; i++ } }
    else if (a === '--since') { const v = value(a, i); if (v !== null) { out.since = v; i++ } }
    else if (a === '--dir') { const v = value(a, i); if (v !== null) { out.dir = v; i++ } }
    else if (a === '--json') out.json = true
    else if (a === '--no-log') out.noLog = true
    else bad ??= `unrecognised argument: ${a}`
  }
  // An error carries the options parsed alongside it. A bare `{ error }` left
  // `noLog` undefined, so a refused run appended the very record the operator
  // had just asked it not to write -- and the next sweep read that back as a
  // finding of its own. Parsing continues past a bad argument for the same
  // reason: the flag governing the log may sit on either side of it.
  if (bad) return { ...out, error: bad }
  if (out.since) {
    // Validated by Date.parse but compared as a string against an ISO `ts`, so
    // anything Date.parse accepts and ISO does not sorted wrong: "Aug 1 2026"
    // passed the check and then excluded every record, reporting a clean sweep
    // of nothing. Normalising here makes the check and the comparison agree.
    const t = Date.parse(out.since)
    if (Number.isNaN(t)) return { ...out, error: `--since must be an ISO timestamp, got ${out.since}` }
    out.since = new Date(t).toISOString()
  }
  return out
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const run = deps.run ?? realRun
  const o = parseArgs(argv)
  if (o.error) return done(o, { outcome: 'preflight', reason: o.error }, EXIT.PREFLIGHT)

  // --repo names THIS repository: the one findings are deduped against, and the
  // only repository name redaction lets through. It does not filter the read --
  // the friction happens in other projects, and that is the entire point.
  let self = o.repo
  if (!self) {
    const r = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: o.dir })
    if (!r.ok) {
      return done(o, { outcome: 'preflight', reason: 'pass --repo <owner/name>, or run this from a checkout of the repository findings are filed against' }, EXIT.PREFLIGHT)
    }
    self = r.out.trim()
  }

  // Not runsDir(): it mkdirs, so the guard below could never fire on the
  // default path. A machine that has never run baton then read as a clean
  // sweep of zero records rather than as having no log at all -- and a
  // read-only verb created a directory as a side effect of looking.
  const dir = o.runs ?? join(batonHome(), 'runs')
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return done(o, { self, outcome: 'preflight', reason: 'the run log directory does not exist' }, EXIT.PREFLIGHT)
  }

  const { records, skipped, files } = readRecords(dir, o.since)
  let candidates = candidatesFrom(records, self)
  const raised = candidates.length

  const disposed = dispositioned()
  candidates = candidates.filter(c => !disposed.has(c.fingerprint))
  const afterDispositions = candidates.length

  if (candidates.length) {
    const got = issueBodies(run, self, o.dir)
    // Fatal, not degraded. A run that cannot see what is already filed is a run
    // that files it again, and a duplicate costs more than a stop.
    if (got.error) {
      return done(o, { self, skipped, files, scanned: records.length, outcome: 'preflight', reason: `could not read existing issues, so nothing can be deduped: ${got.error}` }, EXIT.PREFLIGHT)
    }
    candidates = candidates.filter(c => !got.bodies.some(b => b.includes(c.fingerprint)))
  }

  return done(o, {
    self, skipped, files, scanned: records.length, candidates,
    dropped: { dispositioned: raised - afterDispositions, alreadyFiled: afterDispositions - candidates.length },
    outcome: candidates.length ? 'candidates' : 'ok',
    reason: candidates.length
      ? `${candidates.length} candidate(s) to disposition from ${records.length} record(s)`
      : `nothing to report from ${records.length} record(s)`,
  }, candidates.length ? EXIT.CANDIDATES : EXIT.OK)
}

function done(o, d, code) {
  const report = {
    candidates: d.candidates ?? [],
    skipped: d.skipped ?? 0,
    scanned: d.scanned ?? 0,
    files: d.files ?? 0,
    repo: d.self ?? null,
    dropped: d.dropped ?? { dispositioned: 0, alreadyFiled: 0 },
    outcome: d.outcome,
    reason: d.reason ?? null,
    exit: code,
  }

  const logged = o.noLog ? null : writeRun('audit', d.self ?? null, {
    outcome: d.outcome, exit: code, reason: d.reason ?? null,
    scanned: report.scanned, skipped: report.skipped, candidates: report.candidates.length,
    fingerprints: report.candidates.map(c => c.fingerprint),
  })

  // The JSON is the artefact that becomes an issue body, so it carries nothing
  // redaction would strip -- the run log's own path included, since it is
  // absolute. The human line is a terminal for the operator and may name it.
  if (o.json) { console.log(JSON.stringify(report, null, 2)); return code }

  const L = [`audit: ${String(d.outcome).toUpperCase()} — ${report.reason}`]
  if (report.skipped) L.push(`  ${report.skipped} unreadable line(s) skipped (a torn tail or an unknown schema)`)
  for (const c of report.candidates) L.push(`  [${c.count}x] ${c.kind} ${c.fingerprint} — ${c.title}`)
  if (report.dropped.alreadyFiled || report.dropped.dispositioned) {
    L.push(`  dropped: ${report.dropped.alreadyFiled} already filed, ${report.dropped.dispositioned} dispositioned`)
  }
  if (logged) L.push(`  logged: ${logged}`)
  console.log(L.join('\n'))
  return code
}

if (isMain(import.meta.url)) process.exitCode = main()
