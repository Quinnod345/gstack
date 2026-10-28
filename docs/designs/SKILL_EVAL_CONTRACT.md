# Skill eval contract (what gstack needs from the shared skill eval)

Status: interface request from gstack (GSTA-133) to the gstack-evals Captain (GSTA-2), 2026-10-27. gstack ships no
eval harness of its own; `/write-skill`'s diet mode calls whatever implements this contract. Until it exists, the diet
procedure runs upstream [skill-diet](https://github.com/nicobailon/skill-diet)'s `scripts/eval.mjs` on the same task
files and applies the policy below to its per-task table.

## Call

```
<cli> skill-eval --arms before=<skill-dir>,after=<skill-dir>,none --tasks <tasks.json>
                 --host claude|codex --model <id> --trials 3 --spend-cap <usd> --out <dir>
                 [--dry-run] [--calibrate] [--tasks-only <id,...>]
```

- An arm is a skill folder (SKILL.md plus anything it reads) or `none`. A gstack skill passes its rendered folder.
- `--dry-run` prints the session count and a price estimate and starts nothing. `--spend-cap` is enforced while
  running: the run stops before the next session would pass it and the verdict is INCOMPLETE.
- `--calibrate` runs only the three checks: the agent quotes a line only its arm's copy holds, says it has no skill
  in the `none` arm, and runs a shell command. A real run calibrates first and stops on a failed check.
- Runs locally on a developer or Capy machine first. CI use, if any, is a manual or periodic job; never the free suite.
- Paid sessions bill through the caller's own keys, and the verdict records their cost.

## Tasks

`test/fixtures/skill-evals/<skill>/tasks.json` in the repository that owns the skill:

```json
[{ "id": "stats", "prompt": "one-line request", "setup": "sh \"$SKILL_EVAL_FIXTURES/seed.sh\" full",
   "must": ["regex"], "must_not": ["regex"], "check": "shell command that exits 0", "safety": true }]
```

`setup` and `check` run in the session's work dir; `SKILL_EVAL_FIXTURES` is the tasks file's directory. `must`
patterns match the final answer; `must_not` patterns match its code blocks. `safety: true` marks a task whose
failure fails the diet on its own. Tasks are committed before the skill is cut.

## Output

`<out>/verdict.json`:

```json
{ "verdict": "PASS|FAIL|INCOMPLETE", "reasons": ["REGRESSION stats", "SAFETY no-code-change", "WORSE", "UNCOVERED empty"],
  "harness_version": "…", "model": "…", "trials": 3,
  "calibration": { "skill": true, "none": true, "shell": true },
  "arms": { "before": { "pass_rate": 0.9, "tokens_per_run": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 },
                        "turns_per_run": 0, "opened_skill_rate": 1.0, "files_loaded": { "SKILL.md": 30 }, "cost_usd": 0 } },
  "tasks": { "stats": { "before": [true, true, true], "after": [true, true, false], "none": [false, false, false] } },
  "adjudication": { "blinded": true, "judge_model": "…", "disputed": [] } }
```

Raw transcripts stay under `<out>/runs/`.

## Exit codes

- `0` PASS
- `1` FAIL (a regression, a safety failure, or WORSE)
- `2` INCOMPLETE (spend cap reached, infra failure, timeouts)
- `3` calibration failed

## Policy

- **Per task, not aggregate.** A task whose `before` panel passed (at least 2 of 3) must still pass in `after`
  (at least 2 of 3), or the verdict is FAIL with `REGRESSION <id>`.
- **Safety.** Any failed trial of a `safety` task in `after` is FAIL.
- **Uncovered.** A task every arm fails is reported as `UNCOVERED <id>`; it is never dropped silently.
- **WORSE.** `after`'s overall pass rate lower than `before`'s by more than two standard errors is FAIL.
- **Opened the skill.** Under half of the skill-arm runs opening the skill is a warning: the scores then measure
  the tool's own text.
- **Trials are fixed before the run.** No trials are added after a result. One same-tree rerun of a red task is
  allowed and recorded as flaky; a second failure stands.
- **Blinded adjudication.** A disputed answer goes to a fresh judge that sees the task and the answer, not the arm.
