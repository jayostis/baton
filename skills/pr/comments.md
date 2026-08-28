# `/baton:pr comments <pr>` — list what is outstanding

Reads only. Nothing here changes the PR.

```bash
OWNER=$(gh repo view --json owner --jq .owner.login)
NAME=$(gh repo view --json name --jq .name)
gh api graphql -F owner="$OWNER" -F name="$NAME" -F pr=<pr> -f query='
  query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){
    pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved isOutdated path line
      comments(first:1){nodes{author{login} body url}}}}}}}'
```

**Never hardcode the repo** — this runs in whatever checkout invoked it, and a pinned
`owner`/`name` silently answers about somebody else's PR.

**Every thread with `isResolved: false` is outstanding, and `isOutdated` is not a filter.**
GitHub sets that flag when a thread's anchor line changes, which says nothing about whether the
finding still holds — and an outdated thread is the one a human cannot find, because Files
changed omits it and the UI collapses it. Filtering on it hides live work.

An outdated thread has `line: null`; `original_line` from
`gh api repos/:owner/:repo/pulls/<pr>/comments` is the only pointer to where it was raised.

One line per thread: `path:line` (or `original_line`, marked **outdated**), who wrote it, the
first line of the comment, and the comment `url` — that URL jumps straight to the thread.

**A review's summary `body` is outstanding too, and no thread carries it:**

```bash
gh api repos/:owner/:repo/pulls/<pr>/reviews --jq '.[].body'
```

Nothing can resolve one, so it closes only by whoever fixes it saying so. Expect most to be
empty — the reviewer promises an inline comment per finding, and a finding it could anchor
nowhere may exist only on the caller's stdout, where nothing here can see it.

**Nothing outstanding → say so and stop.** That is the whole answer, not a reason to look harder.

Anything outstanding is what [`/baton:pr followup <pr>`](followup.md) would act on.
