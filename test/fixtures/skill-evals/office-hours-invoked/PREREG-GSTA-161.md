# GSTA-161 preregistration: shared-preamble measurement (preamble-lite vs full) on office-hours

Exploratory. Steers gstack's loadout work (GSTA-140 PR 1b) and supports no public claim. Written and pushed before any paid session.

## Question
Does removing the 13 non-pinned shared-preamble modules lose anything on office-hours when the skill is invoked explicitly, on Opus 5.5 and Haiku 5.5? It is the cheapest broad lever: every tier-2+ skill loads the preamble on use.

## Arms (gstack main ad8e12dff74286885fd0c56e4b5e45eb7e650083, v1.91.319.0)
| arm | render | image id |
|---|---|---|
| before (full) | `gstack-modules render --loadout full`, overlaid in place | sha256:bed5ae3a3d7dfe00945d4e2d6b2629e75e5b7d629ddc14a753959b1e4c910144 |
| after (preamble-lite) | `--modules full,-preamble:voice,-preamble:writing-style,-preamble:completeness,-preamble:confusion,-preamble:evidence,-preamble:context-health,-preamble:question-tuning,-preamble:search-before-building,-preamble:repo-mode,-preamble:brain-health,-preamble:brain-sync,-preamble:upgrade-check,-preamble:context-recovery` (spec_sha256 4a913575c6dde35663c3c26c4accf8302326262f470d7e8341c663da98e61d0a) | sha256:5b9cd8292a0e2e9366da1833263d0053e7a37d37a297c66fd95b92adaa7834c4 |
| before2 | second panel of before | same as before |
Base image sha256:4488d15635cf692838b1d5aad88a2816224ba21f6fceb52eefc20e2dff58500f (Claude Code 2.1.312, Bun 1.4.4). office-hours SKILL.md + sections/preamble.md: before 66,697 bytes, after 55,055 (-17%).

## Tasks
test/fixtures/skill-evals/office-hours-invoked on this branch: office-hours' 11 committed tasks plus lanea-quick's 2 extra tasks (13), each prompt prefixed "Use the /office-hours skill for this. ". Digests: tasks.json 9a6e8b1542447eaf754537e28176a907953d60f7ee0889bc2aa7ff6da4ccb984, tasks.ext.json fcb06788e64b03e829395511a0d848c3c4e44b8a290740c9cdf6b18c239c6088, seed.sh 10b85c8f7fbcdd4ca8f1974ef78f8104b770daac9007144d019aea0bead4538c.

## Runner
quick/lanea-quick at gstack-evals 1b68e637c07cea38f01c01120e02d184575da82c, unmodified, through the GSTA-161 adapter (local, never pushed; a byte check refuses a modified runner). Grading, gates and analysis are the runner's own (analyze.ts): per-task REGRESSION, SAFETY, WORSE, INCOMPLETE and NOT_MEASURABLE (fewer than 5 informative tasks).

## Stages, fixed before the run
- P1: Opus 5.5, arms before/after/before2, 13 tasks x 3 trials = 117 sessions.
- P2: Haiku 5.5, arms before/after, 13 tasks x 3 trials = 78 sessions.
- Pilot (counts toward the cap, reported, not analyzed): 2 Haiku sessions on mode-question (before, after) to confirm the explicit invocation opens the skill and metering works. If Haiku opens the skill in neither, P2 still runs and is reported on opened runs only.
No trials are added after a result. One same-tree rerun of a red task per rule 16, recorded as flaky.

## Reading
Primary: the runner's verdict per model. A PASS with after's pooled pass rate within the before/before2 gap reads as "no loss shown"; a FAIL or a REGRESSION that does not appear between before and before2 reads as a loss. Secondary: loaded bytes, input tokens and cost per session against before2's variation. Results go to GSTA-140 as office-hours-only exploratory evidence.

## Spend
Line item gsta161-preamble, cap $95 (1.3 x the $73 estimate), inside Garry's approval of 2026-10-29 ("Do it"). The runner stops before a session that would pass the cap.
