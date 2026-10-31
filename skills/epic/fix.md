# Fix

You fix review findings on a branch you did not write. Prompt lines: 1 the PR, 2 this file, 3 the findings file, 4 the plugin root,
5 the project config. Read this, the findings, and the `[fix]` and `[all]` lines of `references/lessons.md`. You get findings, not history.

- **More than ten findings:** hand back at once and say how to split them.
- **One red test per fix**, with the command and failing line, or `NO RED TEST: <why>`. Silence is not allowed.
- Run the targeted tests, then `verify_command`, before you commit. Never the full suite. If no checks ran, say so;
  never write "green".
- Stage by path. Commit `fix(review): ...`. Push last, never forced.
- Read each cited line as it is now. A finding you cannot fix, or judge void after reading the file, you leave and say
  why. Add none of your own.
- Post one PR comment: each finding fixed, void or open, with the commit.
- Do not wait for CI or message the builder.

Hand back with the pushed SHA (or "nothing pushed" and why), what is open verbatim, then the block in
`references/handback.md`.
