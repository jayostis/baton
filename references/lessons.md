# Lessons. One line each: [role] rule (what it cost). Hard cap 80 lines, tested; to add one, merge or delete one.
# Roles: all, orchestrator, critical-read, builder, reviewer, fix, mechanical, walk. A retro deletes a line whose reason is gone.
[all] The repo is the witness, not a report: check git log origin/<branch> and the checks on the head SHA (agents reported green from an earlier head).
[all] Pass -R owner/repo to gh every time; gh answered about the wrong repo four times in one epic.
[all] A script exit code is the contract; exit 0 from a session proves nothing, so read the denials and the repo.
[all] Scratch repros go under a short path in Temp; a long scratchpad path broke tests three times.
[all] Never git stash, and never git checkout a ref in a main clone (it left one on a detached HEAD); read another ref with git show <ref>:<path>.
[all] On Windows the Bash tool halves a doubled backslash even inside single quotes (printf '%s' 'a\\b' prints a\b), and source files may be CRLF on disk so scripted string edits miss: write files and code with Edit and Write, never a heredoc, sed or node -e (three fix rounds in one epic, three wrecked edits in the next).
[all] Bring a branch up to date by merging its base, never by rebase and force-push: auto mode refused a dispatch that asked for one.
[all] Only one Docker run at a time, behind the project's lock; never remove a lock you did not take (three OOM kills, one stolen timing lock).
[all] A background command wakes you only after your turn ends; do not start one you need before reporting, and stop every one you started before handing back (a builder re-sent its handback three times at 470k context as its runs ended).
[orchestrator] Never resume a finished agent: five Opus builders resumed 4-9 times were 852M of 1,122M cache reads, and a fresh fix agent cost 58k against 208k for the author.
[orchestrator] Polling CI burned a third of a week; one blocking command, full 40-character SHA, started once.
[orchestrator] Read mergeStateStatus first (DIRTY shows no checks), and trust a checks row only once it shows the new head SHA.
[orchestrator] After every merge, wait-ci.sh on the base branch's new head, and on the main of every repo that runs the merged code (a downstream consumer's main); one main sat red two days unnoticed and cost the next PR a fix round, and a consumer's main sat red two days after upstream merges and cost about 9M units. A main's head is `wait-ci.sh <repo> --commit <sha>`; a bare SHA is refused as "not a PR number" and waits on nothing.
[orchestrator] Merge only through the gate, never from an agent's report or with --admin, and only with merge permission stated in chat in this session (auto mode refuses without it, and refused a merge on permission given in the session before the handoff); ask for it at resume, and record its date in HANDOFF.
[orchestrator] Check a step file's premise about what another system emits (a test runner's output, an API field) against one real run before dispatch, and send a step that decides a policy to the critical read: "node --test prints its failing test" was false and cost a review round and three PRs, and "latest run, any event" held in a step file was the next wave's blocker.
[orchestrator] Give every agent the orchestrator-owned artefacts and rulings once, up front, each input by path: the run folder, the test command, the git ref of code to restore, a ready fixture copy, the key's source and a live try's cost (six handbacks in one epic asked for one of these; three mid-task updates once cost two Docker runs).
[orchestrator] A consumer starts early only against a seam written in the settlements, in its exact shape (the parts, tool names and fields each side keeps), told which suites cannot go green until its producer lands; a seam written as "unchanged" left a reviewer's coupling check conditional.
[orchestrator] A behaviour that rests on a live provider gets one live probe before its step closes, and its fix starts from a captured request: stubbed tests passed a chat reply that went 0 of 1 live, and two guessed causes were wrong where the capture showed a 4096-token cap eaten by thinking.
[orchestrator] Every fix round's diff gets a review-small (about 0.1M units); the orchestrator may read one of a few source lines itself, logged. A fix round's own change replaced a complete reply with a cut-off one, and only that round's review caught it.
[orchestrator] The maintainer's own session with what shipped is a walk; schedule it before calling a phase done (thirty minutes found seven defects, one of them the contract failing live).
[orchestrator] One agent per branch at a time: a second review or a CI red for a branch whose fixer is still running goes to that fixer by SendMessage.
[orchestrator] A findings file quotes the reviewer and any ruling it touches, and names the targeted test command as the repo really runs it; a paraphrase naming one of two commands and an "or otherwise" against a ruling each cost a round, and three fix agents in one epic were handed the wrong runner or the full suite.
[orchestrator] A handoff logged yes ends the session: tell the maintainer and dispatch nothing more, and the next session's id in run.md is the witness; three yes decisions in one epic were each followed by more turns in the same transcript, which reached 716 turns, a 428k peak and 22.7M units. Paste the handoff-decision line --self prints, verbatim: a hand-written one (short session id, no predicted_units) read back as NaN and "handed off no".
[orchestrator] Split a very large diff's review by concern, one reviewer each.
[orchestrator] Reviewers found something on nearly every PR; skipping one is logged in the status line, never silent.
[orchestrator] Name the code path that shows a behaviour before dispatching its fix; a lean has assumed what the engine could not do.
[orchestrator] Advise a handoff only from ledger.mjs --self at a wave boundary; a compaction summary written at 614k context had the orchestrator urge a fresh session at 182k.
[orchestrator] Before redispatching an agent you think is dead, check that its transcript has stopped growing and what its branch holds on the remote and in its worktree; a live Opus builder was duplicated, and two builders taken for lost had left their work in both.
[orchestrator] A Workflow gives each agent the user's triggering message as its first turn; never use one for an agent whose prompt must be only its brief (an eval subject obeyed the relayed message).
[orchestrator] A usage-limit stop kills every agent; only pushed work survives, so tell builders to push early.
[orchestrator] Cite files, symbols and tests by name in step files and briefs, and a page's slot by its row text, never by line number; line numbers went stale within a wave.
[orchestrator] Each wave's status to the maintainer opens with three numbers: units so far, units per merged PR against the history file, and the role with the largest share. One stage took 46% of an epic's units and was shrunk, never questioned, because no status put that number to the maintainer.
[orchestrator] A stage the epic adds beyond build, review and fix is run both ways on the pilot, with and without it, judged by a blind reader, before it is dispatched again; an untried stage ran 39 times and nobody could say whether it was worth anything.
[orchestrator] Close each wave with its own "to" when its last PR merges; w0-w4 closed at one instant made the ledger give w2, w3 and w4 the same 122.8M.
[orchestrator] Put each recurring must-fix class in the next step file as an acceptance check.
[orchestrator] Sharpen during the epic, not at the retro: apply each handback's proposed change that saves a round or a wait, and build the tool or fix the brief on a second round for one reason (a cold-read words loop ran three rounds on each of three PRs; a wrong review-wt.sh call was repeated in several prompts; builders' tool asks were logged "for the retro").
[orchestrator] 20 agents with four or five local test suites locked a 4-core machine into a restart (2026-11-10); the cap is a dispatch hook sized by the machine, heavy and light apart, and heavy.sh holds local suites to its slots.
[critical-read] Reading all steps together found 15 must-fixes in one epic and must-fixes in every other; per-step grooming did not.
[critical-read] A step that rests on an unmeasured number is a step 0: one spike cancelled a step worth 71k tokens and 4 minutes.
[critical-read] Set up the local fast loop first; a host runner removed Docker from the loop and made each check six times faster.
[critical-read] Each step names every reader of what it changes, in every repo: saved output, tests that pin the old value, every consumer that carries a copy; five handbacks in one epic found a reader missing, and one missed test turned a main red. Grep a term's writers by every form it is written in (short form, full form, the constant that holds it); a short-form-only grep missed three writers.
[critical-read] Read the reference implementation before ruling what a field means.
[critical-read] Give a step that changes several repos one builder per repo, producer first; two such steps' single builders each stopped with one repo done, after 5.2M and 5.3M units.
[builder] A test that was never red proves nothing; four vacuous tests were found only by running them on the old code.
[builder] Commit the red test before the implementation so the red is on record.
[builder] Typecheck before you push; three CI rounds were lost to one type error.
[builder] Measure only what changes a decision; 22 minutes went on a fact the repo already stated.
[builder] Never run npm ci in a linked worktree; it costs 5-12 minutes each time and the project's tool already links the cache.
[builder] Merge origin/main before pushing and run verify_command after the merge; the old merge ref is reused otherwise.
[builder] Another repo's stale sibling checkout gave 13 phantom failures; check it is current before trusting a local failure.
[builder] Check every identifier, URL and code you quote at its source: one of twelve URLs was dead and a suggested code named something else.
[reviewer] Probes, adversarial inputs, primary sources and downstream readers found the defects; broad mutation sweeps found nothing.
[reviewer] A blocker costs the builder 30 minutes to 2 hours; give the input that shows it so nobody rediscovers it.
[reviewer] Re-review in the same standing worktree (seconds, against 5-8 minutes for a fresh one): read the diff since the last review and rerun the old repros.
[reviewer] Where the PR's claim is a count, independently recompute it from the primary files; three such recomputations found gaps.
[reviewer] A PR that hands a change list downstream proves it by applying the list in a scratch worktree.
[reviewer] Run a proposed config or lint change before listing it; a lint nit that was never run was wrong.
[reviewer] A pin bump is checked against the registry's publish date, at least 14 days old.
[reviewer] A GitHub workflow step with `shell: bash` runs `bash -e`, so a command that may exit non-zero needs `|| true`; a review that assumed otherwise passed a step that turned main red. Under `pipefail`, a reader that stops early (`awk ... exit`, `head`) gives its writer SIGPIPE and ends the step: probe a job a PR's CI never runs (schedule or dispatch only) with a stub, as a reviewer did with 170KB of stderr.
[fix] A fix agent that was handed ten or fewer findings and no history got every one right; more than ten overran.
[fix] Reply to a thread after fixing, resolve only after the push; a resolution is a claim the fix is on the head.
[fix] Run verify_command and the typecheck (`tsc -b`) before committing; a fix round's new test that was never typechecked turned a PR red, and resetting a pushed commit needs a force push, which is denied.
[fix] Without the repo's toolchain, never assert text you inferred: read the expected text from a CI log or a sibling test first (a PR went red on a guessed message).
[mechanical] Do not repair or retry a failed command; a half-fix pushed over a red build is worse than the red build.
[walk] Walking the shipped thing found what tests did not in six epics, once 507 records written to the wrong destination.
[walk] Save evidence under a path with no spaces; a space breaks the clickable link to it.
