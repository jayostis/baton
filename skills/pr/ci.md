# `/baton:pr ci <pr>` — one look, one attempt

**Checks once. Never polls, never waits, never re-checks.** A verdict that has not arrived is a
result to report, not a reason to sit there. Each invocation is one attempt.

## 1 — Look

Pin the query to the **PR's** head, never to local `HEAD` — your checkout may be elsewhere.

```bash
SHA=$(gh pr view <pr> --json headRefOid --jq .headRefOid)
gh run list --commit "$SHA"
```

**Full SHA only** — an abbreviated one returns an empty list with no error, which reads exactly
like "no CI ran".

- `in_progress` / `queued` → **report it and stop.** Not a failure.
- `success` → report and stop.
- **Every job `skipped`** → **not green.** Report it as skipped and say you do not know why.
- **No run at all** → report that no run exists for this SHA, and stop. **Infer nothing** — the
  project may have no CI, may not use GitHub Actions, or may not trigger on this event. Never
  edit code over it.
- `failure` → step 2.

## 2 — One attempt

```bash
gh run view <run-id> --log-failed
```

**Assert the checkout first** — `gh pr view <pr> --json headRefName` against
`git rev-parse --abbrev-ref HEAD`, and `git status --porcelain` clean. Differ or dirty → **stop
and report.** Do not switch branches: this verb takes a number, and moving someone's tree is not
in it.

Fix the failure the log names, and nothing else. Run what you can locally to check the fix, commit,
push. **Then report and stop** — do not look for a new run. Whether a push triggers one is the
project's business and the next invocation's question.

Cannot tell what failed, or the fix is beyond one attempt → **report it and stop.** A half-fix
pushed over a red build is worse than a red build.

## 3 — Report

The run URL, the failing job, what you changed or why you didn't, and the SHA you pushed — or
"nothing pushed" and why. Never finish silently.
