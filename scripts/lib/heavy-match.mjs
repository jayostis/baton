// Which commands in a shell line are heavy, and the line rewritten to run them through scripts/heavy.sh. The line is
// split into commands at ; & && || | newlines and parentheses outside quotes, so `grep pytest` and `echo "npm test"` name a
// runner without running one. A command is heavy when what it runs, after environment assignments, `time`, `uv run ...`,
// `python -m` and `npx`, begins with one of the patterns: words in order, the last also matching `name:suffix`
// (`npm run test:unit`), a word `(a|b)` standing for either. `bash -c '<string>'` is not looked into.

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const PREFIX = new Set(['time', 'nice', 'exec', 'command', 'nohup'])
const UV_VALUE_OPTIONS = new Set(['--with', '--python', '-p', '--project', '--directory', '--with-requirements', '--env-file', '--group', '--extra', '--with-editable', '--index'])

function tokenize(line) {
  const commands = []
  let tokens = []
  let cur = null
  let quote = null
  const endToken = () => { if (cur) { tokens.push(cur); cur = null } }
  const endCommand = () => { endToken(); if (tokens.length) commands.push(tokens); tokens = [] }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) { cur.text += line[++i] }
      else cur.text += c
      continue
    }
    if (c === '"' || c === "'") { cur ??= { text: '', start: i }; quote = c; continue }
    if (c === ';' || c === '|' || c === '\n' || c === '(' || c === ')' || c === '`') { endCommand(); continue }
    if (c === '&') {
      if (line[i - 1] === '>' || line[i - 1] === '<' || line[i + 1] === '>') { cur ??= { text: '', start: i }; cur.text += c; continue }
      endCommand(); continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { endToken(); continue }
    cur ??= { text: '', start: i }
    cur.text += c
  }
  endCommand()
  return commands
}

const base = (p) => p.split(/[\\/]/).pop()

// Where the command really starts (insertAt: after assignments and the prefixes heavy.sh cannot run) and where what it
// runs starts (matchAt: past `uv run`, `python -m`, `npx`).
function scan(tokens) {
  let i = 0
  for (;;) {
    const t = tokens[i]?.text
    if (t === undefined) break
    if (ASSIGN.test(t) || PREFIX.has(t)) { i++; continue }
    if (t === 'env') { i++; while (tokens[i] && (ASSIGN.test(tokens[i].text) || tokens[i].text.startsWith('-'))) i++; continue }
    break
  }
  const insertAt = i
  for (;;) {
    const t = tokens[i]?.text
    if (t === 'uv' && tokens[i + 1]?.text === 'run') {
      i += 2
      while (tokens[i]?.text.startsWith('-')) i += UV_VALUE_OPTIONS.has(tokens[i].text) ? 2 : 1
      continue
    }
    if (['python', 'python3', 'py'].includes(t) && tokens[i + 1]?.text === '-m') { i += 2; continue }
    if (['npx', 'bunx', 'pnpx'].includes(t)) { i++; while (tokens[i]?.text.startsWith('-')) i++; continue }
    break
  }
  return { insertAt, matchAt: i }
}

const patternWords = (pattern) => {
  const words = pattern.trim().split(/\s+/)
  while (['npx', 'bunx', 'pnpx'].includes(words[0]) && words.length > 1) words.shift()
  return words
}

function matches(words, tokens, at) {
  if (at + words.length > tokens.length) return false
  return words.every((w, k) => {
    const t = tokens[at + k].text
    const options = w.startsWith('(') && w.endsWith(')') ? w.slice(1, -1).split('|') : [w]
    return options.some((o) => t === o || (k === words.length - 1 && t.startsWith(`${o}:`)))
  })
}

const isWrapped = (tokens, insertAt) => {
  const a = tokens[insertAt]?.text
  const b = tokens[insertAt + 1]?.text
  return Boolean((a && base(a) === 'heavy.sh') || (['bash', 'sh', 'source', '.'].includes(a) && b && base(b) === 'heavy.sh'))
}

// The heavy commands in `line` not already run through heavy.sh, and `line` with heavy.sh put in front of each.
export function heavyCommands(line, patterns, heavySh) {
  const compiled = patterns.map(patternWords)
  const found = []
  for (const tokens of tokenize(String(line))) {
    const { insertAt, matchAt } = scan(tokens)
    if (isWrapped(tokens, insertAt)) continue
    const hit = compiled.find((w) => matches(w, tokens, matchAt))
    if (hit) found.push({ pattern: hit.join(' '), at: tokens[insertAt].start })
  }
  let rewritten = String(line)
  for (const { at } of [...found].reverse()) rewritten = `${rewritten.slice(0, at)}bash "${heavySh}" ${rewritten.slice(at)}`
  return { found, rewritten }
}
