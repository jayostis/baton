# `/baton:pr comments <pr>` — list what is outstanding

Reads only. Nothing here changes the PR.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/threads.mjs list --pr <pr> --json
```

It answers for the repository of the working directory; its `threads` and `summaryBodies` are everything below. Read
the script's header, not a copy of its query here.

**Every thread unresolved is outstanding, and `isOutdated` is not a filter.** An outdated thread is the one a human
cannot find, because Files changed omits it, and filtering on it hides live work. The script's `line` falls back to
where the thread was raised, and `outdated` says which.

One line per thread: `path:line` (marked **outdated** where it is), who wrote it, the first line of the comment, and
the thread's `url`, so it can be opened.

**A review's summary body is outstanding too, and no thread carries it** — see `summaryBodies`. Nothing can resolve
one, so it closes only by whoever fixes it saying so. Most are empty.

**Nothing outstanding → say so and stop.**

Anything outstanding is what [`/baton:pr followup <pr>`](followup.md) would act on.
