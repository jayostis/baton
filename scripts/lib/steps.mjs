// What a dispatch description says: the role key, the step and, for a fix round, why it was needed. Shared by the hooks
// that log dispatches, the ledger's --pace and --time, and dispatch.mjs, so they cannot disagree about a description.

// "builder: w3 s07b ...": the first word, lower-cased, is the role key.
export const keyOf = (description) => String(description ?? '').trim().split(/[\s:]/)[0].toLowerCase()

const STEP = /\bw\d+\s+(?:s\d+[a-z\d]*|#\d+)/i

// The step an agent worked, from its description ("builder: w3 s07b ...", "fix: w0 #641 review round"): the wave and the
// step id or PR number after it. Agents whose description names none (the orchestrator, a wave-wide mechanical) have none.
export const stepOf = (description) => STEP.exec(String(description))?.[0].toLowerCase().replace(/\s+/g, ' ') ?? null

// Why a fix round was needed. `fix: w3 s07b words` or `fix: w1 s00 #665 review round`: the first of the three words after
// the step key that is a reason. A fix with none is `other`.
export const REASONS = ['words', 'test', 'review', 'ci-red', 'flake', 'conflict', 'other']

export function reasonOf(description) {
  const text = String(description ?? '')
  const m = STEP.exec(text)
  if (!m) return 'other'
  const after = text.slice(m.index + m[0].length).toLowerCase().split(/[\s,;:]+/).filter(Boolean).slice(0, 3)
  return after.find((w) => REASONS.includes(w)) ?? 'other'
}

// A findings file opens with `Reason: <word>`; a word that is not a reason is `other`, no line is null.
export function reasonFromFindings(text) {
  for (const line of String(text ?? '').split('\n').slice(0, 5)) {
    const m = /^\s*Reason:\s*([A-Za-z-]+)/i.exec(line)
    if (m) return REASONS.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : 'other'
  }
  return null
}

// `owner/repo#N` in a subject line, the PRs and issues a step's agents were pointed at; how a merge finds its step.
export const refsOf = (text) => [...String(text ?? '').matchAll(/([\w.-]+\/[\w.-]+)#(\d+)/g)].map((m) => `${m[1]}#${m[2]}`)
