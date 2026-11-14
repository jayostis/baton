// Which GitHub Actions jobs a pull request never runs but its base branch will: a PR's green says nothing about them, and a
// hub's main once sat red nine hours on a dependency one such job did not install. The gate reads the workflows at the
// PR's head and names these jobs.
//
// A job is main-only when, for a pull_request event, its `if:` (with `success()` implied unless it calls a status
// function, and the results of the jobs it needs) is certainly false, or its workflow has no pull_request trigger; and for
// a push to the base branch or a schedule on it, it is not certainly false. What a PR context cannot know (an event's
// action, a step's output, an input) stays unknown, and an unknown job is never named.
//
// Only what this needs of YAML is read: the `on:` triggers and push branch filters, and each job's name, if and needs.

const indentOf = (line) => /^ */.exec(line)[0].length
const unquote = (s) => {
  const t = String(s).trim()
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t
}
const flowList = (s) => {
  const t = String(s).trim()
  if (!t.startsWith('[')) return t ? [unquote(t)] : []
  return t.slice(1, t.lastIndexOf(']')).split(',').map(unquote).filter(Boolean)
}
const expression = (s) => {
  const t = unquote(s).trim()
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(t)
  return (m ? m[1] : t).replace(/\s+/g, ' ').trim()
}

// A key's value: inline, a block scalar (> or |) or a block list (- item), from the lines after it deeper than `indent`.
function valueAt(lines, i, indent, inline) {
  const rest = []
  let j = i + 1
  for (; j < lines.length; j++) {
    const l = lines[j]
    if (l.trim() === '' || l.trim().startsWith('#')) continue
    if (indentOf(l) <= indent) break
    rest.push(l.trim())
  }
  if (/^[>|][-+]?$/.test(inline)) return { text: rest.join(' '), end: j }
  if (inline === '' && rest.length && rest.every((l) => l.startsWith('- ') || l === '-')) return { list: rest.filter((l) => /^-\s+\S/.test(l) && !/^-\s+\S+:/.test(l)).map((l) => unquote(l.slice(1))), end: j }
  return { text: inline, end: j }
}

export function parseWorkflow(text) {
  const lines = String(text).replace(/\r/g, '').split('\n')
  const out = { on: {}, jobs: [] }
  for (let i = 0; i < lines.length; i++) {
    const top = /^(?:"on"|'on'|on|true):\s*(.*?)\s*$/.exec(lines[i])
    if (top) {
      if (top[1]) { for (const e of flowList(top[1])) out.on[e] = null; continue }
      const child = lines.slice(i + 1).find((l) => l.trim() && !l.trim().startsWith('#'))
      const at = child ? indentOf(child) : 0
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() === '' || l.trim().startsWith('#')) continue
        if (indentOf(l) === 0) break
        const ev = indentOf(l) === at && /^\s*([A-Za-z_-]+):\s*(.*?)\s*$/.exec(l)
        if (!ev) continue
        const spec = {}
        const inner = lines.slice(j + 1).find((x) => x.trim() && !x.trim().startsWith('#'))
        const innerAt = inner && indentOf(inner) > at ? indentOf(inner) : null
        for (let k = j + 1; innerAt !== null && k < lines.length; k++) {
          const x = lines[k]
          if (x.trim() === '' || x.trim().startsWith('#')) continue
          if (indentOf(x) <= at) break
          const kv = indentOf(x) === innerAt && /^\s*([A-Za-z_-]+):\s*(.*?)\s*$/.exec(x)
          if (!kv) continue
          const v = valueAt(lines, k, innerAt, kv[2])
          spec[kv[1]] = v.list ?? flowList(v.text)
        }
        out.on[ev[1]] = Object.keys(spec).length ? spec : null
      }
      continue
    }
    if (/^jobs:\s*$/.test(lines[i])) {
      const child = lines.slice(i + 1).find((l) => l.trim() && !l.trim().startsWith('#'))
      const at = child ? indentOf(child) : 0
      let job = null
      let keyAt = null
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() === '' || l.trim().startsWith('#')) continue
        const d = indentOf(l)
        if (d === 0) break
        if (d === at) {
          const id = /^\s*([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(l)?.[1]
          job = id ? { id, name: null, if: null, needs: [] } : null
          if (job) out.jobs.push(job)
          keyAt = null
          continue
        }
        if (!job) continue
        if (keyAt === null) keyAt = d
        if (d !== keyAt) continue
        const kv = /^\s*([A-Za-z_-]+):\s*(.*?)\s*$/.exec(l)
        if (!kv) continue
        if (kv[1] === 'name') job.name = unquote(kv[2])
        else if (kv[1] === 'if') job.if = expression(valueAt(lines, j, d, kv[2]).text)
        else if (kv[1] === 'needs') { const v = valueAt(lines, j, d, kv[2]); job.needs = v.list ?? flowList(v.text) }
      }
    }
  }
  if (!out.jobs.length && !Object.keys(out.on).length) throw new Error('no triggers and no jobs')
  return out
}

// ---- expressions, three-valued: a value, or undefined where the context cannot know it.

function tokens(src) {
  const out = []
  const s = String(src)
  for (let i = 0; i < s.length;) {
    const c = s[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === "'") {
      let j = i + 1
      let v = ''
      for (; j < s.length; j++) {
        if (s[j] === "'" && s[j + 1] === "'") { v += "'"; j++; continue }
        if (s[j] === "'") break
        v += s[j]
      }
      out.push({ t: 'str', v }); i = j + 1; continue
    }
    const op = /^(==|!=|<=|>=|&&|\|\||[!<>(),])/.exec(s.slice(i))
    if (op) { out.push({ t: 'op', v: op[1] }); i += op[1].length; continue }
    const num = /^-?\d+(\.\d+)?/.exec(s.slice(i))
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*(?:(?:\.[A-Za-z0-9_*-]+)|(?:\[[^\]]*\]))*/.exec(s.slice(i))
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue }
    throw new Error(`cannot read ${s.slice(i, i + 10)}`)
  }
  return out
}

const truthy = (v) => (v === undefined ? undefined : !(v === false || v === 0 || v === '' || v === null))
const norm = (v) => (typeof v === 'string' ? v.toLowerCase() : v)

function compare(op, a, b) {
  if (a === undefined || b === undefined) return undefined
  let x = norm(a)
  let y = norm(b)
  if (typeof x !== typeof y && (typeof x === 'number' || typeof y === 'number')) { x = Number(x); y = Number(y) }
  if (op === '==') return x === y
  if (op === '!=') return x !== y
  if (typeof x !== typeof y) return false
  return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y
}

const FUNCTIONS = {
  startswith: (a, b) => (a === undefined || b === undefined ? undefined : String(norm(a ?? '')).startsWith(String(norm(b ?? '')))),
  endswith: (a, b) => (a === undefined || b === undefined ? undefined : String(norm(a ?? '')).endsWith(String(norm(b ?? '')))),
  contains: (a, b) => (a === undefined || b === undefined ? undefined : Array.isArray(a) ? a.map(norm).includes(norm(b)) : String(norm(a ?? '')).includes(String(norm(b ?? '')))),
  always: () => true,
  cancelled: () => false,
  failure: () => false,
}

function parse(toks, ctx) {
  let i = 0
  const peek = () => toks[i]
  const eat = (v) => { if (peek()?.v !== v) throw new Error(`expected ${v}`); i++ }
  const primary = () => {
    const t = toks[i++]
    if (!t) throw new Error('unexpected end')
    if (t.t === 'str' || t.t === 'num') return t.v
    if (t.t === 'op' && t.v === '(') { const v = or(); eat(')'); return v }
    if (t.t === 'op' && t.v === '!') { const v = truthy(primary()); return v === undefined ? undefined : !v }
    if (t.t === 'id') {
      const name = t.v.toLowerCase()
      if (name === 'true') return true
      if (name === 'false') return false
      if (name === 'null') return null
      if (peek()?.v === '(') {
        i++
        const args = []
        while (peek() && peek().v !== ')') { args.push(or()); if (peek()?.v === ',') i++ }
        eat(')')
        if (name === 'success') return ctx['success()']
        return Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name](...args) : undefined
      }
      return Object.hasOwn(ctx, t.v) ? ctx[t.v] : undefined
    }
    throw new Error(`unexpected ${t.v}`)
  }
  const cmp = () => {
    let a = primary()
    while (peek()?.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(peek().v)) { const op = toks[i++].v; a = compare(op, a, primary()) }
    return a
  }
  const and = () => {
    let a = cmp()
    while (peek()?.v === '&&') {
      i++
      const b = cmp()
      const ta = truthy(a)
      a = ta === false ? a : ta === true ? b : truthy(b) === false ? false : undefined
    }
    return a
  }
  const or = () => {
    let a = and()
    while (peek()?.v === '||') {
      i++
      const b = and()
      const ta = truthy(a)
      a = ta === true ? a : ta === false ? b : truthy(b) === true ? b : undefined
    }
    return a
  }
  const v = or()
  if (i < toks.length) throw new Error(`unexpected ${toks[i].v}`)
  return v
}

// true, false, or undefined when the context cannot decide it.
export function evaluate(expr, ctx = {}) {
  return truthy(parse(tokens(expr), ctx))
}

// ---- jobs

const glob = (pattern, name) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`).test(name)

function pushRuns(spec, base) {
  if (spec === null || spec === undefined) return true
  if (spec.branches) return spec.branches.some((b) => glob(b, base))
  if (spec['branches-ignore']) return !spec['branches-ignore'].some((b) => glob(b, base))
  return !spec.tags && !spec['tags-ignore']
}

const STATUS_CALL = /\b(always|success|failure|cancelled)\s*\(/i

// 'run', 'skip' or 'maybe' for every job, in one event context.
function statuses(jobs, ctx) {
  const by = Object.fromEntries(jobs.map((j) => [j.id, j]))
  const memo = {}
  const of = (id, seen = new Set()) => {
    if (memo[id]) return memo[id]
    if (!by[id] || seen.has(id)) return 'maybe'
    seen.add(id)
    const job = by[id]
    const needs = job.needs.map((n) => of(n, seen))
    const local = { ...ctx }
    job.needs.forEach((n, k) => { local[`needs.${n}.result`] = needs[k] === 'run' ? 'success' : needs[k] === 'skip' ? 'skipped' : undefined })
    // A skipped job's outputs are empty.
    for (const [key, n] of String(job.if ?? '').matchAll(/needs\.([\w-]+)\.outputs\.[\w-]+/g)) if (needs[job.needs.indexOf(n)] === 'skip') local[key] = ''
    local['success()'] = needs.includes('skip') ? false : needs.includes('maybe') ? undefined : true
    let v
    try {
      const own = job.if ? evaluate(job.if, local) : true
      v = job.if && STATUS_CALL.test(job.if) ? own : own === false || local['success()'] === false ? false : own === true && local['success()'] === true ? true : undefined
    } catch { v = undefined }
    memo[id] = v === true ? 'run' : v === false ? 'skip' : 'maybe'
    return memo[id]
  }
  return Object.fromEntries(jobs.map((j) => [j.id, of(j.id)]))
}

export function mainOnlyJobs(files, { base, defaultBranch = base }) {
  const out = []
  for (const { file, text } of files) {
    let wf
    try { wf = parseWorkflow(text) } catch { continue }
    const prTrigger = 'pull_request' in wf.on || 'pull_request_target' in wf.on
    const pr = prTrigger ? statuses(wf.jobs, { 'github.event_name': 'pull_request', 'github.ref': 'refs/pull/1/merge', 'github.ref_name': '1/merge', 'github.base_ref': base }) : null
    const main = []
    const mainCtx = (event) => ({ 'github.event_name': event, 'github.ref': `refs/heads/${base}`, 'github.ref_name': base, 'github.base_ref': '' })
    if ('push' in wf.on && pushRuns(wf.on.push, base)) main.push(statuses(wf.jobs, mainCtx('push')))
    if ('schedule' in wf.on && base === defaultBranch) main.push(statuses(wf.jobs, mainCtx('schedule')))
    for (const job of wf.jobs) {
      const neverOnPr = !pr || pr[job.id] === 'skip'
      if (neverOnPr && main.some((s) => s[job.id] !== 'skip')) out.push({ file, id: job.id, name: job.name })
    }
  }
  return out
}
