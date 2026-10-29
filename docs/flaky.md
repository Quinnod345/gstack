# Flaky tests: rerun once and record it (`gstack-flaky`)

`gstack-flaky run` runs your test command, reads the JUnit report it writes,
and reruns each failed test once. A test that passes on its rerun is a
**flaky pass**: the job stays green and the flake is recorded on a ledger, so
the daily flaky pass can fix it at the source. A test that fails twice is red.
This is CREW rule 16 ("run the failed test again and note that it is flaky")
for any runner that writes JUnit: Playwright, `bun test`, jest, vitest and
pytest. gstack's own free suite keeps its file-level retry
(`GSTACK_FREE_RETRY_FLAKY`, [Flake ledger](TESTING_INTERNALS.md#flake-ledger)).

## Get started in GitHub Actions

```yaml
- uses: oven-sh/setup-bun@v2
  with: { bun-version: 1.4.4 }
- name: Install gstack-flaky (pinned)
  env: { GSTACK_REF: <a gstack commit sha you have tested> }
  run: |
    git clone --quiet --filter=blob:none https://github.com/garrytan/gstack.git "$RUNNER_TEMP/gstack"
    git -C "$RUNNER_TEMP/gstack" checkout --quiet "$GSTACK_REF"
- name: E2E
  env:
    PLAYWRIGHT_JUNIT_OUTPUT_NAME: results/junit.xml
    GSTACK_FLAKE_LEDGER_JUNIT: ${{ runner.temp }}/flaky-junit-ledger.jsonl
  run: |
    "$RUNNER_TEMP/gstack/bin/gstack-flaky" run --junit results/junit.xml -- npx playwright test --reporter=line,junit
- if: always()
  uses: actions/upload-artifact@v4
  with: { name: flaky-junit-ledger-e2e, path: "${{ runner.temp }}/flaky-junit-ledger.jsonl", if-no-files-found: ignore, retention-days: 90 }
```

Replace `GSTACK_REF` with a gstack commit you have tested; the bin needs only
Bun and git. In Actions it also writes a step-summary table of the flaky
passes and one `::warning` annotation per flaky test, so they are visible on
the run before anyone reads the ledger.

## Runners

| Runner | Command after `--` | Rerun |
|---|---|---|
| Playwright | `npx playwright test --reporter=line,junit` with `PLAYWRIGHT_JUNIT_OUTPUT_NAME=<file>` | The failed test alone (`<file> --grep <title> --project <project>`) when the summary proves the run complete, else the whole command. `gstack-flaky` sets `PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1` so Playwright's own `retries` are reported; with retries configured, those attempts stand and nothing is rerun again. |
| bun | `bun test --reporter=junit --reporter-outfile=<file>` | The failed test alone (`<file> --test-name-pattern <title>`) when the summary proves the run complete, else the whole command. |
| jest, vitest, pytest (`--runner generic`) | your command, writing JUnit | Always the whole command: a generic runner's output cannot prove that every test ran. |

The command after `--` runs without a shell. When it needs one, wrap it as
`bash -c '<script> "$@"' _` so a targeted rerun's selection arguments reach
the runner. A targeted rerun appends its selection to the same command, each
one argument, so a title with shell or regex characters selects only itself.

## Rules

- **One rerun, small failures only.** A failed test gets one rerun when the
  runner made no retries and at most `--max-reruns` (3) tests failed. More
  failures than that is a real red, and nothing is rerun.
- **A targeted rerun needs a complete first run.** The failed test is rerun
  alone only when the runner exited 1 (its test-failure status) and its own
  summary is present with no early stop: bun's `Ran N tests` line without
  `Bailed out`, Playwright's `N failed` line without `did not run`,
  `interrupted`, `Testing stopped early` or a global timeout. Otherwise the
  rerun repeats the whole command (`FLAKY_RERUN: scope=command (<why>)`), so
  a test the first run never reached (`--bail`, `--max-failures`, `-x`)
  still has to pass. When the run is already red for another test, a
  whole-command rerun is skipped.
- **A rerun clears a test only cleanly.** The rerun's command must exit 0 and
  the test must run once and pass on its first attempt; a rerun the runner
  retried again does not count.
- **Never green by accident.** The report is deleted before every attempt, and
  a report that attempt did not write counts as missing. A missing, empty,
  zero-test or malformed report fails, as does a non-zero exit with no failed
  test (a crash or a non-test step) and a runner killed by a signal. When the
  runner's summary counts failures its JUnit omits (a bun file that fails to
  load, a Playwright error outside any test), the run is red and nothing is
  rerun.
- **Reports.** After the run, `--junit` holds the first run's report, so a
  later upload or test reporter sees what failed. Each rerun's report is kept
  beside it as `<name>.rerun-<n>.xml`.
- **Ids.** A test is `<file>::<project>::<describe > title>`, with the project
  empty outside Playwright, so a test in two browser projects is two tests.
  `gstack-flaky ids --junit <file>` prints them.
- **Ledger.** One JSON line per flaky pass (`kind: flaky-pass`) and per test
  that failed its rerun (`rerun-fail`), with the tree, commit, branch, run URL,
  attempts, the rerun's scope (`test` or `command`) and the first lines of
  the error. Ids, paths and failure text go through gstack's redaction engine
  first; when the scan cannot run, they are withheld. The path is `--ledger`,
  else `GSTACK_FLAKE_LEDGER_JUNIT`, else
  `<state root>/flake-ledger-junit.jsonl`, and `FLAKY_RESULT` names it. It is
  kept apart from the free suite's file-level ledger (`GSTACK_FLAKE_LEDGER`).
  A ledger write error is a warning and never changes the verdict.

## Output and exit codes

One `FLAKY: <flaky-pass|fail|rerun-fail> <id> attempts=<…> (<reason>)` line per
test that failed at least once, `FLAKY_RERUN: scope=command (<why>)` when the
rerun repeated the whole command, then
`FLAKY_RESULT: tests=<n> failed=<n> flaky=<n> reruns=<n> command_exit=<n> verdict=pass|fail ledger=<file|none>`.

| Exit | Meaning |
|---|---|
| 0 | Every test passed, flaky passes included |
| 1 | A test failed (after its rerun, or with no rerun), including `FLAKY_UNREPORTED_FAILURES` |
| 2 | Usage error, including a `--junit` path that is not a `.xml` file |
| 3 | No usable report, a crash, or a killed runner (a code below on stderr) |

| Code | Exit | Cause | Fix |
|---|---|---|---|
| `FLAKY_NO_RESULTS` | 3 | No report at `--junit`, an empty one, or one with no testcase | Make the command write JUnit to that path |
| `FLAKY_JUNIT_INVALID` | 3 | The report is not well-formed XML | Make sure one process writes it and nothing appends to it |
| `FLAKY_RETRIES_HIDDEN` | 3 | Playwright retried but its report omits the retries | Set `PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1` where the report is written |
| `FLAKY_COMMAND_FAILED` | 3 | Non-zero exit with no failed test | Read the command output: a real red |
| `FLAKY_COMMAND_KILLED` | 3 | The runner was killed by a signal (a cancelled job, an OOM kill) | Nothing was rerun; rerun the job |
| `FLAKY_COMMAND_NOT_STARTED` | 3 | The command could not be started | Check the argv after `--` |
| `FLAKY_UNREPORTED_FAILURES` | 1 | The runner counted failures or errors its JUnit omits | Fix the load error or the error outside any test: a real red |
| `FLAKY_LEDGER_WRITE_FAILED` | — | The ledger could not be appended (warning) | Check the path; the verdict stands |
