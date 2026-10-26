# Changelog

## [Unreleased]

**`gstack-ship-queue ready` counts CI the way GitHub's rollup does, and names the way through a CHANGELOG-only conflict.** A superseded run (gbrain saw a cancelled `contributor-gate` beside three later passes on the same head) made `ready` print `failed=1` where GitHub showed 0 failed, and a PR that conflicts with main on CHANGELOG alone had no documented route to green CI on its head.

### Fixed
- **`ready`'s `ci:` line** (`lib/ship-queue.ts`, new `latestRunPerName`) judges each check name by its latest run (newest `completed_at`, then highest id; a run still in progress is newest), so a cancelled or re-run earlier attempt no longer counts as a failure; runs without a name and commit-status contexts are counted one each, as before.
- **`ready` prints a `ci-hint:` line on a conflicting PR** (`gh pr view` now also reads `mergeable` and `headRefName`): with no CI at the head it names the procedure (dispatch `free-tests.yml` and `windows-free-tests.yml` with `gh workflow run … --ref <branch>`, clear the pregate lanes with the run URLs, rerun `ready`); with green runs at the head it says the dispatched runs count. No hint without a conflict, or while the runs are red or pending.
- **Docs:** `docs/ship-policy.md` records that procedure under "Lane: report ready" (and that `--screen` is `QUEUE_SCREEN_STALE_REF` on such a PR), rewords the `stamp-at-merge` row's `next:` description to the train wording `gstack-restamp` prints since #3439 (`commit and push only the stamp diff above (FILES), with no edit of your own`), and rewords the restamp `changelog` stage so `CHANGELOG_DUPLICATE_HEADING` is described as #3439 implements it: only a duplicate the PR introduces counts, measured against the base's CHANGELOG.

### Tests
- `test/gstack-ship-queue.test.ts`: two runs of one check name where the older is cancelled read green (either order), a newer failure reads red, a newer in-progress run reads pending, equal `completed_at` falls back to the id, unnamed runs stay separate, and a commit status never collapses with a check run of the same name; a conflicting PR with no CI refuses with the dispatch hint, with green dispatched runs READYs with the "counts" hint, and no hint appears without a conflict or while runs are red or pending.

**An unstamped PR can change a release output again (GSTA-96 on #3434).** Regenerating `agents-digest/gstack-AGENTS.md` after a generator change made the Version Gate classify the head as stamped (the digest is in `release_outputs`) and demand base + bump, while changing only `scripts/gen-agents-digest.ts` failed `test/agents-digest.test.ts`'s freshness check, so a digest rewording could not land before its slot.

### Fixed
- **Version Gate under a train policy** (`lib/version-gate-train.ts`, `scripts/compare-pr-version.ts`): a changed `release_outputs` file no longer counts as a stamp when it is byte for byte what the policy's `release_tool` generates at the head's merge base's `VERSION` (the head's own, since `VERSION` is unchanged on this path; the base tip may have stamped since, and CREW rule 14 says not to merge it); the gate runs the head's tool in a throwaway worktree with that `VERSION` (the changed outputs removed first, a bare environment with `GSTACK_RESTAMP_VERSION` and `GSTACK_RESTAMP_STAGING=1` and none of the gate's tokens, no `node_modules` link, a 120 s limit enforced with SIGKILL so a tool that ignores TERM cannot hold the gate open, output read from a file, first 4 KB, so a lingering child cannot either) and compares byte for byte. `VERSION` and `package.json` version changes still classify the head as stamped, as does an output that differs (hand-edited, generated at a bumped version, or never written by the tool) or a policy with no `release_tool`; a tool that exits non-zero, is killed or cannot be staged is an error with the reason, never a pass; the staging worktree is removed and pruned on every path. `version-gate.yml` checks the head out with `persist-credentials: false`, since the head's tool now runs inside the gate. The freshness test stays strict and a stamp commit still changes only the stamp files, since the slot's restamp regenerates the output. `docs/ship-policy.md` states the rule under "Lane: report ready".

### Tests
- `test/compare-pr-version.test.ts`: a generator change with its regenerated output at the merge base VERSION passes as unstamped (red without the fix), and stays unstamped after main stamps again; a tool whose background child outlives it does not hold the gate open, nor does one that traps TERM (`regeneratedAtBase` is exported for that test); a hand-edited output, an output generated at the bumped version, an output the tool never writes, a VERSION bump without the output, a failing release tool and a policy without `release_tool` all still refuse; the tool sees no `GH_TOKEN`; no worktree is left behind.

## [1.91.226.0] - 2026-10-26

**/review can re-review just its own fixes after a fixing pass, under the same rules as /ship (#3339).** Before, every /review fix cycle reran the whole review over the whole branch, so a large branch could hit the three-cycle stop on findings in code the earlier passes had already read. Now the pass after an edited pass starts with `gstack-review-log --start review --fix-range` and its checklist, specialists and QA read only what changed since that pass. The Step 4.8 adversarial review still reads the whole branch on every pass, because its rows carry their own freshness. A narrowed pass is never the final review: when it makes no edits, /review runs one full pass before writing the final record, and a fix-range record is never CURRENT. Garry's "do it" on 2026-10-24 for a fix-range re-review with a final full pass covers it.

### Changed
- **`review/SKILL.md.tmpl`** Step 3: the first pass always starts full. The pass right after an edited pass starts with `--start review --fix-range`, and wherever that pass sets DIFF_BASE outside Step 4.8 it uses the printed `FIX_BASE=<sha>` instead. Step 4.8 and every other `<base>` use (state-matrix detection, the gate, banned-terms and slop scans, the queue check) keep the base branch. State-matrix detection builds `origin/<base>` from its argument, and the slop scan diffs `<base>...HEAD`, which is empty while /review's fixes are uncommitted. If the logger refuses (for example, the first pass read uncommitted work, so no commit marks what it read), the pass starts full.
- **Step 5.8**: an edited pass now saves its own record with `converged:false` before the repeat, because the fix-range start takes its base from that record. Before, only the final pass was logged. Step 5.0 never treats this invocation's own records as prior reviews, so a defect the user skipped this invocation is not suppressed on the next pass and still counts as unresolved. "No edits" fills the final record only after a full pass; after a fix-range pass it repeats Steps 3–5 with a full start. Each logged pass finishes its own REVIEW_START.
- Nearby prose was tightened to pay for the growth (the slop-scan note, the Step 4.7 probe-reuse rule, the search-before-recommending list, the version-compare note, the final-report and Greptile lines). Every host's review SKILL.md shrank by 36 characters, and its size pin was lowered to match. The Claude skeleton is 80,581 bytes against its 80,900 cap.

### Tests
- `test/review-fix-range.test.ts` adds five cases. Two check the rendered rules: the first pass's start block has no `--fix-range`, only the pass after an edited pass narrows, FIX_BASE replaces only DIFF_BASE outside Step 4.8, a refusal falls back to a full start, the edited pass is logged before the repeat and kept out of Step 5.0, and a fix-range pass is never final. Three run /review's real order on every pass against the real logger: core start, then the Step 4.8 attempt's start and finish, then fixes in the working tree, then the core finish with the pass's own token, and never a commit. A committed first pass narrows the next repeat to the uncommitted fixes, and the following repeat is refused back to a full pass that is CURRENT. A zero-edit fix-range row is UNVERIFIED even if it were logged. A first pass over uncommitted work can't be narrowed.
- `test/review-workflow-clarity.test.ts`: three expectations follow the new contract: the "No edits" marker, the edited pass saving its record with `converged:false`, and each pass finishing its own token instead of only the final one. The test formerly named "finish only the final core token without log-time capture" is now "each logged pass finishes its own core token without log-time capture". It still requires one `--finish REVIEW_START`, no `--start review` in Step 5.8 and no log-time token capture.

### Gate integrity
- One gate change to review: /review may narrow a repeat pass. Verdict: this does not weaken what the final review covers, because a narrowed pass can't be the final record. The logger never marks a fix-range row CURRENT, Step 5.8 requires a full pass after a zero-edit fix-range pass, Step 4.8 stays full, and Step 5.0 can't suppress this invocation's skipped defects through its own intermediate records. Mutation checks on the rendered skill, each caught by the suite:
  - letting a fix-range pass be final;
  - dropping the full-pass condition on "No edits";
  - narrowing every repeat;
  - dropping the refusal fallback;
  - narrowing the first pass;
  - not logging the edited pass;
  - logging after the repeat;
  - narrowing Step 4.8 and other base uses;
  - letting Step 5.0 read this invocation's records.
- No threshold, budget, timeout, trial count or case kind changed. Size pins only went down.

## [1.91.225.0] - 2026-10-26

**/design-html builds landing pages around one visitor action and pages that look finished, without inventing proof; adapted from Elaya's design skills (GSTA-92).** Freeform /design-html asked for purpose, audience and feel, then built. It never asked for the one action the page exists for or where the traffic comes from, and nothing caught a page that shipped with invented customers and numbers, a dead `href="#"`, a scroll-listener reveal, `100vh`, or no description, favicon or working skip link. Now every run reads a craft section at Step 1, and a free checker counts the tells at Step 4. Adapted from Elaya's [ai-design-skills](https://github.com/elayadesign/ai-design-skills) (landing-page-design, design-to-motion) and [redesign-skill](https://github.com/elayadesign/redesign-skill), MIT, © 2026 Elaya. Thank you, Elaya.

### Changed
- **/design-html reads `sections/craft.md` on every run (Step 1).** The spec opens with `Surface: Persuade` or `Surface: other`. A Persuade page (landing, pricing, waitlist, campaign, comparison) asks at most three multiple-choice questions (primary action, traffic source, published or reference) and states the rest in one `Assumed:` line; picks one of four archetypes with a reason; keeps the hero budget (one proof signal only when real proof exists, never a metric row) and chooses the rest of the page from the archetype and objections; gives the primary action real invalid, pending, failure and success states. Every page: claims (testimonials, logos, results, prices, guarantees) come only from the user, and missing proof is left out or marked `[Needs proof: …]`; illustrative data looks real; a ship floor scoped to full documents (title, description, favicon, share tags on shareable pages, `og:image` only from a supplied URL, a skip link that reaches `<main>`, landmarks, alt text, inline validation, no dead links, `aria-current` on route navigation); scale snapping with readability floors and the nested-radius rule; balanced line breaks; motion rules for the one authored moment (content visible without script, `IntersectionObserver`, cheap properties only, no `scale(0)`, named curves, `100dvh`).
- **Step 4** runs `bin/gstack-design-craft` after the Slop Gate, whether or not the detector is installed, with the gate's contract: one fix pass, one rerun, the rest accepted with a reason, once more when the refinement loop ends. The hand-off opens with a "Before this can ship" block: proof markers, production dependencies, exceptions, and every claim the check changed.
- **/design-shotgun**: a landing, pricing or campaign screen's variants also differ in page archetype, keep the one primary action identical, and carry their section outline as a caption.

### Added
- **`bin/gstack-design-craft`** (`lib/design-craft.ts`): prints `CRAFT_CHECK: <id> <count> <fix>` per tell and `CRAFT_RESULT: clean` (exit 0) or `<n> issue(s)` (exit 1); exit 2 on a non-HTML, empty or unreadable file. Copy rules read decoded visible text; `alert()` counts only in scripts; head and navigation rules run only on a full document. Buzzwords report under the catalog's `marketing-buzzword` id.
- **NOTICE.md** and `licenses/MIT-elaya.txt`. Not carried over, because they conflict with gstack's design rules: Elaya's fixed fonts (Geist and Poppins are on gstack's overused-display list), palette, spacing values and icon sets, gradient hero text, mandatory scroll reveals and tagline section, and the island nav.

### Tests
- `test/design-craft.test.ts`: every tell with its count; a finished page, inlined Pretext, a `100vh` line with its `100dvh` fallback, discount copy and in-page anchors stay clean; look-alike attributes, encoded markers, `!important` and reversed fallbacks; skip links judged by position and target in any language; the craft section's banned words and names all flagged; CLI exit codes.
- `design-html-slop-gate` also requires the craft check to run once or twice; the design-html carve guard requires the craft section read.

## [1.91.224.0] - 2026-10-25

**`/context-restore` now says when commits landed after a checkpoint was saved, instead of offering finished steps as the plan.** `/context-save` recorded the branch, a timestamp and the modified files, but not the commit, so a checkpoint saved before a step was committed came back with that step still listed under Remaining Work. Ported from #3316 by @soyames, with their commit kept.

### Fixed
- **`bin/gstack-slug --stamp-checkpoint`** also writes `head:`, the commit the save describes, next to `remote:`, `project_root:` and `worktree:`. A re-stamp replaces it rather than adding a second line.
- **`/context-restore`** compares `head:` with `HEAD` before presenting. When commits landed after the save it prints how many and lists up to ten, and puts every Remaining Work item under Verify first. A saved commit that is not in this checkout's history (saved on another branch, rebased, reset, or not fetched) is reported the same way. A malformed `head:` is checked as 40 or 64 hex digits before any git command sees it, `head:` is read from the frontmatter only, and outside git the comparison uses the saved `worktree:` before `project_root:`. Checkpoints saved before this keep their usual sorting with a one-line note.

### Tests
- `test/context-restore-head.test.ts` runs the real save-path, stamp and head-check blocks from the generated SKILL.md files in fixture repos: unchanged, two commits landed, diverged after a reset, resumed from another branch, a nested linked worktree restored from outside git, a re-stamp after a new commit, pre-tracking, a `head:` that appears only in the body, and a `head: $(touch pwned)` that must never execute.

## [1.91.223.0] - 2026-10-25

**/plan-tune's inferred profile finally moves: a clicked answer is logged as the question's registered option key, not its label.** #2623 showed every inferred dimension stuck at 0.5 on a 1,286-event log: the AskUserQuestion hook recorded labels like "A) Fix it now (recommended)", while the signal map that turns answers into dimension nudges is keyed by registered option keys like `fix-now`, so 0 of 1,286 answers matched. Now five hook-captured label answers to the registered architecture-finding question move `architecture_care` from 0.5 to 0.632, and `--trace` lists all five.

### Fixed
- **`bin/gstack-question-log`**: on a hook-captured event (`source: hook`) for a registered `question_id`, the clicked label is mapped to that question's registered option key before it is written, and the label is kept in a new `choice_label` field. A label in `recommended` is mapped the same way, so `followed_recommendation` compares keys. Ad-hoc and `hook-<hash>` ids and unmatched or ambiguous labels are written as given. Rows from other writers (the agent's own log call, auto-decide, Codex import, typed free text) are unchanged, because readers such as the plan-ceo-review auto-decide check match the full mode names those rows carry. Existing logs are not rewritten.
- **`scripts/psychographic-signals.ts`**: new `resolveOptionKey(question_id, label)`. It strips the `A)` selector and `(recommended)` suffix, then matches the label's leading words against the question's own options only: each key's own words (`fix-now` → "fix now") plus a short cue list ("Add to TODOs" → `defer`, "Ship as-is" → `skip`, "HOLD SCOPE" → `hold`). The longest cue wins and a tie stays unmapped.

### Tests
- `test/plan-tune.test.ts`: every registered option resolves from its own words, bare and as an `A) … (recommended)` label; 20 common phrasings, including the four plan-ceo-review mode names, map to their keys; negative controls (unregistered ids, a question with no options, a label naming no option, a mid-sentence cue, another question's key, a number that looks like a selector) stay unmapped. Two capture tests run the real bin: hook labels become keys with `choice_label` kept, while agent rows (including a `HOLD SCOPE` auto-decide row), ad-hoc ids, unmatched labels and free text are untouched, and a picked label follows a key recommendation. Both capture tests fail against the old bin.

### Gate integrity
- No test expectation, threshold, budget, timeout, trial count or case kind changed. Existing tests that pin label rows from the agent, auto-decide and Codex import paths pass unchanged.

## [1.91.222.0] - 2026-10-25

**Five flaky tests now fail only for real defects, and a judge reply that isn't valid JSON says so in its failure line (daily flaky-fix pass, GSTA-91).** `context-restore-fragment-match` failed 0/3 on main cb99df4, although every run restored the right checkpoint: to find the checkpoint whose title matches, the agent often prints all three, and the case failed whenever another checkpoint's body appeared anywhere in the transcript. `test/gstack-ff-update.test.ts` counted every `sleep 300` on the machine, so heartbeats from parallel test files changed its count (remote pregate at #3412's head: expected "1", received "3"). The `GSTACK_CAPY=1` install-admission case in `test/gstack-skill-start.test.ts` makes ten `gstack-skill-start` spawns under bun's 5 s default timeout and took 3.6–5.7 s on a 4-core machine. The QA-only fixture's late scenarios mocked a 1000 ms capture budget but ran each attempt's real setup inside it. The setup-browser-cookies workflow judge in train-4 gate 40173759210 returned JSON with an unescaped quote in its reasoning, and the flake record read only "JSON Parse error: Expected '}'".

### Fixed
- **`test/helpers/context-restore-fragment.ts`** (new): `fragmentRestoreVerdict` reads only the agent's report (top-level assistant text and the final result), never tool output. The report must carry the payments checkpoint's body and no other checkpoint's body. `test/skill-e2e-context-skills.test.ts` uses it for the fragment-match case.
- **`test/helpers/llm-judge.ts`**: when a judge response is not valid JSON, `callJudge` throws a `SyntaxError` that names the judge output, its stop reason and length, and the retained `llm-judge-response-parse-error` event. It still fails closed and parses no score; the request is unchanged.

### Tests
- `test/context-restore-fragment-verdict.test.ts` replays the three captured false reds from main (`test/fixtures/context-restore-fragment-match-captures.json`) as passes. Controls that must fail: captures rewritten to resume alpha or omega, synthetic runs that read and resume only alpha or omega, resume summaries that mix two checkpoints, and a payments body that appears only in tool output. Restoring the old any-byte surface fails all four positive controls. Focused paid runs of the case: 0/3 on main, 3/3 after (about $0.11 a trial).
- `test/llm-judge-frontier.test.ts` replays the exact captured cookie-judge reply: it fails closed with no score, one request and the new diagnosis. It fails on the previous helper.
- `test/gstack-ff-update.test.ts`: the reap case runs `gstack-ff-update` with a heartbeat interval unique to the test process and counts only sleepers of that interval, starting from zero. The old count failed with a loop starting unrelated `sleep 300` processes beside it (expected "5", received "14"); the new one passes, and still fails when the bin stops reaping its sleeper.
- `test/qa-only-fixture.test.ts`: in the late scenarios the fixture clock stands still from the start of each attempt until its runner starts, so the real setup work (directory copies and five `git` calls) costs no fixture time. The runner and cleanup stay on the real clock, as the deadline-evidence check requires. Each late capture must now get exactly the 1000 ms budget. A new `late-slow-retry` scenario stalls each attempt's setup for 1100 ms, longer than the whole budget, and its attempt 2 still has to succeed. Before, a loaded machine either used up the work budget in setup (`QA-only work budget exhausted`) or Bun's 1580 ms deadline killed a setup `git` child (exit `null` at `skill-e2e-qa-workflow.test.ts:133`); this is what failed late-retry in the 2026-10-24 and 2026-10-25 remote pregates. Under 24 busy loops on 4 cores: late-retry 1/20 → 20/20, late-failure-retry 2/20 → 20/20, late-timeout 6/20 → 20/20, late-slow-retry 20/20. Reverting the clock fails all four late scenarios unloaded; reverting the deadline fails `late-slow-retry`.
- `test/gstack-skill-start.test.ts`: the `GSTACK_CAPY=1` install-admission case gets an explicit 20 s timeout. Measured on a 4-core Capy machine with a temporary 60 s cap: 3.6–5.7 s through Capy's git shim (9 of 10 over 5 s), 2.6–4.9 s with the real git binary. Four of its ten spawns are full admissions at about 800 ms each.

### Gate integrity
- One test budget changed, approved by GStack Minder on 2026-10-25: the install-admission case's timeout goes from bun's 5 s default to 20 s, about 3.5 times the 5.7 s worst case measured above. No assertion changed.
- The QA-only late scenarios register each attempt with its real outer budget (1000 + 80 + 5000 = 6080 ms, the value `outerMs` already asserts) instead of a shortened 1580 ms Bun deadline, which left cleanup 500 ms of real time under load. Measured child totals with the fix under 24 busy loops, 20 runs each: late-timeout 2.4–2.7 s, late-retry 4.1–4.3 s, late-failure-retry 4.7–5.0 s, late-slow-retry 6.2–6.6 s, against the parent's unchanged 15 s spawn timeout. The mocked 1000 ms capture budget, the 80 ms drain and every existing assertion are unchanged. Verdict: justified, because the deadline was a fixture artifact shorter than the budget the case declares, and the clock freeze, not the deadline, is what removes the load sensitivity.
- `context-restore-fragment-match`: the failure surface moves from the whole transcript to the agent's report. Alpha or omega bytes in tool output no longer fail the case; the payments body in tool output no longer counts as loaded, so the report must show it. A run that resumes another checkpoint, or mixes two, still fails. `test/test-of-test-ratchet.test.ts` gains one BASELINE entry, the replay test, with its reason, and the new helper joins the touchfiles of the nine context-skills cases, as the derived-closure rule requires.
- `scripts/harness-version.json` records `test/helpers/llm-judge.ts` as non-behavioral at HARNESS_VERSION 6: only a parse failure's message changes, before any score is parsed, so no case's verdict or pass-rate series changes.
- No threshold, trial count, case kind, rubric, judge request or prompt changed.

## [1.91.221.0] - 2026-10-25

**The session-start updater no longer skips because of its own session's workflow lease, and the autostash tests stop failing their first pass in Free Tests.** Since #3385, `gstack-session-update` skips the fast-forward while another session holds a workflow lease, and it means to ignore the session that started it (`--exclude-ancestry-of`). The check runs in the forked background updater, though, and passed the hook's own `$$`, which has exited by then, so the ancestry walk excluded nothing. A Claude Code process that had already run a skill (and so held a lease) and then started a session again in the same process (`/clear`, resume or compaction) logged `SKIP leased pid=<its own pid>` and never updated. `test/session-update-autostash.test.ts` hit the same gap plus a fixture leak: its first two fixtures spawned the updater with the whole parent environment, so it read the test preload's `GSTACK_LEASE_DIR`, which every test file in the same Bun process shares. A lease another file left there gave "Received: SKIP leased pid=3196/1m" where UPDATING or PULL_FAILED was expected, in 13 Free Tests runs since #3385 merged (each passed on the serial retry).

### Fixed
- **`bin/gstack-session-update`**: before it forks, the hook resolves its caller's harness pid with `gstack_harness_pid "$PPID"` (`bin/gstack-harness-pid.sh`), the same derivation `bin/gstack-skill-start` uses for the pid it leases, and the background lease check excludes that pid's ancestry. Leases held by other live sessions still skip the update. `bin/gstack-upgrade` runs its check in the foreground, so its `$$` is alive and it is unchanged.

### Tests
- `test/session-update-autostash.test.ts`: every fixture now runs the updater with its own `GSTACK_STATE_ROOT` (the top of the state-root chain, instead of `GSTACK_STATE_DIR`, which an inherited `GSTACK_HOME` outranks) and its own `GSTACK_LEASE_DIR`. A negative control holds a live lease in the shared preload lease directory, confirms the ambient environment sees it, and shows the fixture still updates; it fails with "SKIP leased" without the fixture change. A positive case shows the fixture's own live lease still skips the update.
- `test/session-update-stages.test.ts`: the starting session's own lease (the test process, behind a `/bin/sh -c` wrapper as a hook runner would use) no longer blocks the update. It fails on main with `SKIP leased`. The other session-update test files already pass an explicit environment, so their leases resolve to the fixture install's own git dir.

### Gate integrity
- No threshold, budget, timeout, trial count, case kind or assertion changed. The lease rule is narrower in one respect only: the starting session's own harness and its ancestors no longer count as holders, which is what `--exclude-ancestry-of` promised.

## [1.91.220.0] - 2026-10-25

**A design doc edited in host plan mode no longer goes stale for the plan reviews (#542).** When /office-hours ran inside Claude Code's plan mode, the design doc lived twice: gstack's copy under `~/.gstack/projects/<slug>/` and the host's plan file under `.claude/plans/`. Later edits went only to the plan file, so /plan-ceo-review and /plan-eng-review read the older gstack copy and called it the source of truth. The gstack design doc stays the single source (Garry, Oct 17: "designdoc"). Edits made in the plan copy are now written through to it, and every plan review is warned when the copy is newer.

### Fixed
- **`office-hours/SKILL.md.tmpl`**: the closing design-doc check takes the host plan file that holds the doc. When that file is newer and differs, it is copied over the gstack doc (`PLAN_COPY: written through`), and the pairing is recorded beside the doc in `<doc>.plan-copy`. A repo copy under `docs/designs/` is rewritten from the doc under Phase 5's scan rule. An older plan file never overwrites the doc, and outside plan mode nothing is recorded.
- **`bin/gstack-design-doc-find`**: when the newest state-root doc has a recorded plan copy, the helper prints `DESIGN_PLAN_COPY` with the write-through command on stderr. When the copy is newer than the chosen doc and differs from it, it also prints `STALE_DESIGN_DOC` with the `cp` to run before reading. Stdout still prints only the doc path, so every caller of `{{DESIGN_DOC_DISCOVERY}}` (plan reviews, /autoplan, the spec-review prerequisite check) gets the lines with no change in rendered size. The write-through always targets the state-root doc, even when a newer repo copy won discovery.
- **`plan-ceo-review/SKILL.md.tmpl`, `plan-eng-review/SKILL.md.tmpl`**: the design-doc check runs a `STALE_DESIGN_DOC` write-through before reading and says so in one line. After a review edits the plan copy, it runs the `DESIGN_PLAN_COPY` write-through after the exit gate, before telemetry.
- To stay within the SKILL.md size pins, plan-eng-review drops its 15th cognitive pattern ("Error budgets", already named in pattern 7), and office-hours drops three explanatory sentences (cross-team discovery, the profile binary's mktemp details, the `sessions[]` array) and shortens one.

### Tests
- `test/design-doc-plan-copy.test.ts` runs the real helper and the generated office-hours block against temp state roots: no recorded copy (silent), a copy in sync (named, no warning), a newer edited copy (warning; running its printed `cp` updates the doc and clears it), a doc edited after the copy (no warning), relative, non-markdown and missing recorded paths (ignored), and a repo copy that wins discovery (the write-through still targets the state-root doc). The office-hours block writes newer plan edits through, never lets an older plan file overwrite the doc, and records nothing outside plan mode. Both plan reviews carry the helper's two line names.

### Gate integrity
- Size pins in `test/fixtures/skill-md-size-allowlist.json` only go down: plan-eng-review by 44 characters on 11 hosts, office-hours by 31 on 4 hosts. No pin was raised. No threshold, budget, timeout, trial count or case kind changed.

## [1.91.219.0] - 2026-10-25

**Local paid runs from `eval:bg` now set `EVALS_RUN_ID`, so the native-capture cases start instead of failing in 0 seconds.** CI sets `EVALS_RUN_ID` per slice, but `bun run eval:bg:pr --local` launched without it, and the qa-callers, ship-docsync and qa-functional cases refuse to start without it. In GSTA-70's local /ship run, 17 of the 26 selected behaviors failed that way for $0. A failure like that is a launch failure, not a verdict, so the local run told you nothing about those cases.

### Fixed
- **`scripts/eval-bg.ts`**: the local backend launches through a new `launchLocal`. It exports `EVALS_RUN_ID` as the run-scoped log's name, reduced to `[A-Za-z0-9_.-]`, and keeps a value you exported yourself. The id is written on the log's second line, so you can find the run's native captures. `--help` says so. Dispatched CI runs are unchanged.

### Tests
- `test/eval-detach-timeout-floor.test.ts`: a detached child launched by `launchLocal` sees a safe `EVALS_RUN_ID` named after its log, and an exported id is kept. A source check confirms that the local backend launches through `launchLocal`.

## [1.91.218.0] - 2026-10-25

**`gstack-team-init required` now blocks skills when its gate can't run, instead of letting them through.** Issue #3319 (exGeni): the required-mode Skill hook is a `node -e` launcher. On a teammate's Mac or Linux machine without Node.js, the shell exits 127 with nothing on stdout. If `.claude/hooks/check-gstack.cjs` is missing, node exits 1. Claude Code treats any exit other than 0 or 2 as a non-blocking error, so in both cases the Skill call went ahead on exactly the machine the gate is for. A live Claude Code 2.1.310 session with node off PATH and no gstack install ran the skill.

### Fixed
- **`bin/gstack-team-init`**: the check-gstack handler is registered with `"onFailure": "block"`, Claude Code's documented fail-closed switch (2.1.295+). A launcher that can't start, or exits with any code other than 0 or 2, now blocks the Skill call. The reason shown is `blocking because onFailure is "block"` plus the shell's `node: not found` (or node's `Cannot find module …check-gstack.cjs`). Exit 2 (deny) and exit 0 (allow) are unchanged. Re-running `required` upgrades an existing registration in place, and the manual-registration fallback names the field.
- The required CLAUDE.md section tells the agent what those two block reasons mean (install Node.js; the hook file is missing) and not to work around them. `required` prints that every developer needs node on PATH and Claude Code 2.1.295+, and the README says the same.

### Compatibility
- Measured with a live `claude -p` Skill call per version. 2.1.295 and 2.1.310 block when node is missing or the hook file is gone, still deny with exit 2 when gstack is absent, and still run the skill when gstack is installed. 2.1.294 ignores the unknown field without rejecting the settings file: the hook still loads and denies as before, and a machine without node is still let through there, as it was before this change.
- Copilot CLI documents command `preToolUse` hooks as already failing closed on a crash or non-zero exit, so this change does not alter its outcome. Its handling of the extra field was not measured (no Copilot login on the test machine).

### Tests
- `test/gstack-team-init-hook-schema.test.ts`: the handler is `{ type, command, onFailure: 'block' }`. The registered command exits 127 with no stdout when node is off PATH and 1 when check-gstack.cjs is missing, the failures only `onFailure` turns into a block. Re-running upgrades a handler registered without the field to exactly one handler with it.
- `test/team-init-hook-shell-neutral.test.ts`: through the platform's default shell, the command without node exits neither 0 nor 2 with empty stdout, and the bin registers the handler with `onFailure: 'block'`. The PowerShell case and its retries are unchanged.
- `test/team-mode.test.ts`: the legacy-upgrade assertion pins the new field.

### Gate integrity
- One gate edit, and it tightens the gate: the required-mode Skill hook goes from fail-open to fail-closed when its launcher fails. Nothing that used to block now allows. Negative controls: with `onFailure` removed from the bin, 4 tests fail (the three new registration and upgrade tests plus the team-mode pin); with it dropped only from the in-place upgrade path, 2 fail. The live runs with gstack installed (2.1.294, 2.1.310) still run the skill, so the allow path is not broken. No threshold, budget, timeout, retry or trial count changed.

## [1.91.217.0] - 2026-10-25

**Windows free tests now also run on every push to main.** `windows-free-tests.yml` ran on pull requests and dispatch only: 194 PR runs, 6 dispatches and 0 pushes in its last 200 runs. Merge trains dispatch only `free-tests.yml` on the train branch. So no Windows run ever saw a train's combined tree or main after a merge, and a Windows break caused by two individually green PRs only surfaced on the next unrelated PR. Found while working on GSTA-68.

### Fixed
- **`.github/workflows/windows-free-tests.yml`**: adds `push: branches: [main]`, the same trigger free-tests.yml already has. The run uses the existing per-run concurrency group, and `record_durations` stays dispatch-only (on a push, `inputs.record_durations` is empty, so the lane runs and the recorder skips). Cost: about 40 job-minutes on GitHub's free `windows-latest` runners per merge.

### Tests
- `test/windows-native-workflows.test.ts` pins the new trigger set and requires the push trigger to be limited to main.

## [1.91.216.0] - 2026-10-25

**/sync-gbrain refuses an active autopilot before it touches the brain's source list (#3360, part 2; ported from #3362 by @exGeni).** The code stage checked for a running `gbrain autopilot` only right before its destructive walk. By then it had already cleaned up legacy sources, renamed a source and run `gbrain sources add`, so a refused run still registered a source it never synced.

### Fixed
- **`bin/gstack-gbrain-sync.ts`**: the code stage runs the autopilot check before Step 0a, so a refusal leaves the source list untouched. The check before the walk stays, because autopilot can start while the steps in between run. Dry-run, read-only and deny policies and the local-engine skip still return earlier and are unchanged. Which processes count as an autopilot (the machine-wide probe, #3360 part 1) is unchanged.

### Tests
- `test/gstack-gbrain-sync.test.ts` runs the real script against a fake `gbrain` and a `pgrep` that reports an autopilot: the stage is refused and the fake saw no `sources add`, `rename`, `remove` or `sync`. On main the same run issues `sources add`.

## [1.91.215.0] - 2026-10-25

**An unattended `/ship` leaves its receipt in a file the parent can read, and the parent is told to read that file (GSTA-88).** Before, Step 18's handoff section wrote the ship receipt only to stdout, and `docs/unattended.md` told the parent to read it from the PR body with `gstack-ship-receipt read --pr <n> --json`. An unattended run must not push, so there is no PR: the parent got a usage error or `RECEIPT_MISSING`, or, if an older PR existed, read that PR's receipt with exit 0 and a stale `head`. Now the handoff writes `.gstack/tmp/ship-receipt.md`, the parent reads it with `read --body` in the child's checkout, and it compares the receipt's `head` to the branch SHA either way.

### Fixed
- **`ship/sections/handoff.md.tmpl`**: the receipt write carries `--out .gstack/tmp/ship-receipt.md`. The completion-message step drops `(\`pr: none\`)`, which was wrong (the block omits `pr`; only the `SHIP_RECEIPT:` line shows `pr=-`), and the "nothing precedes the identifiers" clause, which repeated "identifiers first". Ship's skeleton plus sections is 313,151 bytes, 13 below main and under its 313,281 cap; no cap or pin moved.
- **`bin/gstack-skill-start`**: an unattended `/ship` prints one status line, `UNATTENDED_SHIP: no push, no PR; Step 18 takes the handoff section; receipt at .gstack/tmp/ship-receipt.md`. No other skill or session kind prints it, and no instruction block was added. The unattended block's `/ship` record sentence names the file for a run that did not push and the PR body only once a PR exists.
- **`docs/unattended.md`**: for `/ship`, read `gstack-ship-receipt read --body .gstack/tmp/ship-receipt.md --json` in the child's checkout when the run did not push, use `read --pr <n> --json` only once a PR exists, and in both cases compare the receipt's `head` to the branch SHA, because `read` does not check that the receipt is current.

### Tests
- `test/gstack-ship-receipt.test.ts` runs the handoff template's write command as written in a fixture repository, then reads the file back with `read --body`: `head` is HEAD, `session_kind` is `unattended` and there is no `pr`. It also checks that the template and the generated section carry `--out` and that `docs/unattended.md` names the same file with `read --body`.
- `test/gstack-skill-start.test.ts` checks that the `UNATTENDED_SHIP` line appears exactly once for an unattended `/ship`, alongside only the `unattended-session` block, and never for `/review`, `/qa`, `/autoplan` or for `/ship` in an interactive, spawned or headless session.

## [1.91.214.0] - 2026-10-25

**`gstack-brain-sync --publish-removals --yes` no longer prints `list: unbound variable` when it finishes, and it now removes its temp list and releases the sync lock.** The command's EXIT trap named the function's local `$list`. When a publish succeeded, the function returned before the script exited, so the trap ran after `list` had gone out of scope. Under `set -u` it stopped at the unbound variable and never reached the cleanup, which left `brain-sync-removals.*` in `$TMPDIR` and `.brain-sync.lock.d` in `~/.gstack` until a later run cleared the lock as stale (found by GSTA-44).

### Fixed
- **`bin/gstack-brain-sync`**: `--publish-removals` writes the temp file paths into its EXIT/INT/TERM trap when it installs the trap (quoted with `printf %q`), so the cleanup and lock release work however the function ends. The drain's trap in `--once` also names locals, but every path in that function ends with `exit` while they are still in scope, so it's unchanged. The other trap sites (the drain's lock-only trap and `gstack-brain-restore`'s, which uses a global) don't have the bug.

### Tests
- `test/brain-sync-removals.test.ts`: a new case runs `--publish-removals`, then `--publish-removals --yes` twice (publishing, then nothing to publish) with a private `TMPDIR`. After each run, stderr has no `unbound variable`, the exit status is 0, `TMPDIR` is empty and the lock directory is gone. It failed before the fix.

## [1.91.213.0] - 2026-10-25
