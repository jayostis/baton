# Lessons. One line each: [role] rule (what it cost). Hard cap 80 lines, tested; to add one, merge or delete one.
# Roles: all, orchestrator, critical-read, builder, reviewer, fix, mechanical, walk. A retro deletes a line whose reason is gone.
[all] The repo is the witness, not a report: check git log origin/<branch> and the checks on the head SHA (agents reported green from an earlier head).
[all] Pass -R owner/repo to gh every time; gh answered about the wrong repo four times in one epic.
[all] A script exit code is the contract; exit 0 from a session proves nothing, so read the denials and the repo.
[all] Scratch repros go under a short path in Temp; a long scratchpad path broke tests three times.
[all] Never git stash (it was used though forbidden); Edit and Write repo files, since a heredoc halves backslashes.
[all] Only one Docker run at a time, behind the project's lock; never remove a lock you did not take (three OOM kills, one stolen timing lock).
[all] A background command wakes you only after your turn ends; do not start one you need before reporting.
[orchestrator] Resuming a finished agent re-reads all it ever read: five Opus builders resumed 4-9 times were 852M of 1,122M cache-read tokens.
[orchestrator] A fresh Sonnet fix agent given only the findings and the branch cost 58k against 208k for resuming the author.
[orchestrator] Polling CI burned a third of a week; one blocking command, full 40-character SHA, started once.
[orchestrator] After a push the checks table shows the old head for a while; wait for the new SHA before trusting a row.
[orchestrator] A DIRTY merge state shows no checks; read mergeStateStatus first, then the checks.
[orchestrator] Merge permission must be stated in chat; auto mode refuses without it. Record the date in HANDOFF.
[orchestrator] Never merge from an agent's report, and never with --admin; the gate reads the state itself.
[orchestrator] Give every builder the orchestrator-owned artefacts and rulings once, up front; three mid-task updates cost two Docker runs and a CI wait.
[orchestrator] Tell an early-starting consumer which suites cannot go green until its producer lands.
[orchestrator] A consumer may start early only against a seam written in the settlements; wait for review only if review may change the contract.
[orchestrator] One agent per branch at a time; fold a second review into a running fix round.
[orchestrator] Split a very large diff's review by concern, one reviewer each.
[orchestrator] Reviewers found something on nearly every PR; skipping one is logged in the status line, never silent.
[orchestrator] Name the code path that shows a behaviour before dispatching its fix; a lean has assumed what the engine could not do.
[orchestrator] Context: the orchestrator is re-sent every turn; at the ceiling write the handoff and start fresh, never compact on.
[orchestrator] A usage-limit stop kills every agent; only pushed work survives, so tell builders to push early.
[orchestrator] Cite files and symbols in step files, not line numbers; they went stale within a wave.
[orchestrator] Put each recurring must-fix class in the next step file as an acceptance check.
[orchestrator] Notes between steps go one file per step; one shared file grew to 766 lines and conflicted on its index.
[critical-read] Reading all steps together found 15 must-fixes in one epic and must-fixes in every other; per-step grooming did not.
[critical-read] A step that rests on an unmeasured number is a step 0: one spike cancelled a step worth 71k tokens and 4 minutes.
[critical-read] Set up the local fast loop first; a host runner removed Docker from the loop and made each check six times faster.
[critical-read] Before adding to a shared scheme or term, grep every reader in every repo.
[critical-read] Read the reference implementation before ruling what a field means.
[builder] A test that was never red proves nothing; four vacuous tests were found only by running them on the old code.
[builder] Commit the red test before the implementation so the red is on record.
[builder] Typecheck before you push; three CI rounds were lost to one type error.
[builder] Measure only what changes a decision; 22 minutes went on a fact the repo already stated.
[builder] A PR body edit re-fires CI; write every partner body before the first push and edit once.
[builder] Never run npm ci in a linked worktree; it costs 5-12 minutes each time and the project's tool already links the cache.
[builder] Merge origin/main before pushing and run verify_command after the merge; the old merge ref is reused otherwise.
[builder] Another repo's stale sibling checkout gave 13 phantom failures; check it is current before trusting a local failure.
[builder] Check every IRI, URL and code you quote at its source: one of twelve URLs was dead and a suggested code was a different drug.
[reviewer] Probes, adversarial inputs, primary sources and downstream readers found the defects; broad mutation sweeps found nothing.
[reviewer] A blocker costs the builder 30 minutes to 2 hours; give the input that shows it so nobody rediscovers it.
[reviewer] Re-review reads the diff since the last review and reruns the old repros, in the same worktree.
[reviewer] A fresh worktree and npm ci for each review cost 5 to 8 minutes; the standing worktree costs seconds.
[reviewer] Where the PR's claim is a count, independently recompute it from the primary files; three such recomputations found gaps.
[reviewer] A PR that hands a change list downstream proves it by applying the list in a scratch worktree.
[reviewer] A pin bump is checked against the registry's publish date, at least 14 days old.
[fix] A fix agent that was handed ten or fewer findings and no history got every one right; more than ten overran.
[fix] Reply to a thread after fixing, resolve only after the push; a resolution is a claim the fix is on the head.
[fix] Run verify_command before committing; resetting a pushed commit needs a force push, which is denied.
[mechanical] Do not repair or retry a failed command; a half-fix pushed over a red build is worse than the red build.
[walk] Walking the shipped thing found what tests did not in six epics, once 507 records written into the wrong pod.
[walk] Save evidence under a path with no spaces; a space breaks the clickable link to it.
