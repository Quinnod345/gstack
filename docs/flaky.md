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
    GSTACK_FLAKE_LEDGER: ${{ runner.temp }}/flake-ledger.jsonl
  run: "$RUNNER_TEMP/gstack/bin/gstack-flaky" run --junit results/junit.xml -- npx playwright test --reporter=junit
- if: always()
  uses: actions/upload-artifact@v4
  with: { name: flake-ledger-e2e, path: "${{ runner.temp }}/flake-ledger.jsonl", if-no-files-found: ignore, retention-days: 90 }
```

Pin a gstack commit you have tested; the bin needs only Bun and git. In Actions it also writes a step-summary table of the flaky passes and
one `::warning` annotation per flaky test, so they are visible on the run
before anyone reads the ledger.

## Runners

| Runner | Command after `--` | Notes |
|---|---|---|
| Playwright | `npx playwright test --reporter=junit` with `PLAYWRIGHT_JUNIT_OUTPUT_NAME=<file>` | `gstack-flaky` sets `PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1` so Playwright's own `retries` are reported. With retries configured, those attempts stand and nothing is rerun again. A rerun adds `<file> --grep <title> --project <project>`. |
| bun | `bun test --reporter=junit --reporter-outfile=<file>` | A rerun adds `<file> --test-name-pattern <title>`. |
| jest, vitest, pytest (`--runner generic`) | your command, writing JUnit | Give the rerun selection with `--rerun-arg` templates, for example pytest: `--rerun-arg {file} --rerun-arg -k --rerun-arg {title}`. `{file}`, `{title}` and `{pattern}` (the anchored, regex-escaped title) each fill one argument. |

The command after `--` runs without a shell. Wrap it as
`bash -c '<script>'` when it needs one. A rerun runs the same command with the
selection arguments appended, each one argument, so a title with shell or
regex characters selects only itself.

## Rules

- **One rerun, small failures only.** A failed test gets one rerun when the
  runner made no retries and at most `--max-reruns` (3) tests failed. More
  failures than that is a real red, and nothing is rerun.
- **Never green by accident.** The report is deleted before every attempt, and
  a report that attempt did not write counts as missing. A missing, empty,
  zero-test or malformed report fails, as does a non-zero exit with no failed
  test (a crash or a non-test step). Only the targeted test is read back from
  a rerun.
- **Ids.** A test is `<file>::<project>::<describe > title>`, with the project
  empty outside Playwright, so a test in two browser projects is two tests.
  `gstack-flaky ids --junit <file>` prints them.
- **Ledger.** One JSON line per flaky pass (`kind: flaky-pass`) and per test
  that failed its rerun (`rerun-fail`), with the tree, commit, branch, run URL,
  attempts and the first lines of the error. Failure text goes through gstack's
  redaction engine first; when the scan cannot run, the excerpt is withheld.
  The path is `--ledger`, else `GSTACK_FLAKE_LEDGER`, else
  `<state root>/flake-ledger-junit.jsonl`, and `FLAKY_RESULT` names it. A
  ledger write error is a warning and never changes the verdict.

## Output and exit codes

One `FLAKY: <flaky-pass|fail|rerun-fail> <id> attempts=<…> (<reason>)` line per
test that failed at least once, then
`FLAKY_RESULT: tests=<n> failed=<n> flaky=<n> reruns=<n> command_exit=<n> verdict=pass|fail ledger=<file|none>`.

| Exit | Meaning |
|---|---|
| 0 | Every test passed, flaky passes included |
| 1 | A test failed (after its rerun, or with no rerun) |
| 2 | Usage error |
| 3 | No usable report, or the command crashed (a code below on stderr) |

| Code | Cause | Fix |
|---|---|---|
| `FLAKY_NO_RESULTS` | No report at `--junit`, an empty one, or one with no testcase | Make the command write JUnit to that path |
| `FLAKY_JUNIT_INVALID` | The report is not well-formed XML | Make sure one process writes it and nothing appends to it |
| `FLAKY_RETRIES_HIDDEN` | Playwright retried but its report omits the retries | Set `PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1` where the report is written |
| `FLAKY_COMMAND_FAILED` | Non-zero exit with no failed test | Read the command output: a real red |
| `FLAKY_COMMAND_NOT_STARTED` | The command could not be started | Check the argv after `--` |
| `FLAKY_RERUN_UNSUPPORTED` | A generic runner without `--rerun-arg` | Add `--runner` or `--rerun-arg` templates |
| `FLAKY_LEDGER_WRITE_FAILED` | The ledger could not be appended (warning) | Check the path; the verdict stands |
