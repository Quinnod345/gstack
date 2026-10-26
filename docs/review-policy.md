# Review policy: how gstack's reviews converge

This is the canonical statement of what a gstack review may block on, how the
`/ship` review loop converges, and what the ship receipt records about it. The
skills (`/review`, `/ship`) and the tools (`gstack-review-scope`,
`gstack-ship-receipt`) implement it; a team's own rules should point here
instead of restating it. A one-line crew rule is enough:

> Review convergence: gstack review policy (docs/review-policy.md), scope knob default.

## The blocking floor

A finding is **blocking** when it is a CRITICAL defect: it would fail a test,
break production, or lose data or secrets. Everything else is below the floor:
an advisory, an informational item, a test finding (category `testing`: a gap,
a weak or flaky test), a wording or naming note, a style or simplification
suggestion. Below-floor findings are reported, never fixed after pass 1 of a
ship, and never earn another review pass.

Three words cover every finding, and the loop budgets by them: a **blocker** is
the intended case gone wrong (the floor above); a **should** is a real bug a
caller will hit inside the intended case (fixed when it is in the diff on pass
1, deferred when it is not); a **nit** is the rest (a named note). Two stop
rules follow: if a pass's fixes grew the diff past what the request needs, cut
that growth first; and the cap approves nothing, so a standing blocker is
reported, never waved through.

Before a merged finding counts, the parent applies lead judgment
(`review/sections/review-army.md`, `ship/sections/review-army.md`, stage 4 of
the merge): a reviewer whose whole return is nits found nothing; a defect names
the call site or input that reaches it, or it is a note; structure for a case
nothing takes is advisory; "I would have done it differently" is not a finding;
a finding that assumes a rule the repository documents otherwise is dropped with
the pointer. Independent agreement between reviewers is the strongest signal.

Every reviewer prompt gstack dispatches (the core checklist, each specialist,
the Red Team, the outside voice) carries this definition: CRITICAL means the
floor above; everything else is INFORMATIONAL. Data loss, a trust-boundary
bypass and uncapped spend stay forced CRITICAL (the sideways sweep rule); no
lane, specialist, dedup or saved decision downgrades them.

## `NO FINDINGS` is a result

A reviewer that finds nothing answers `NO FINDINGS` and nothing else. That is a
completed, clean result, never a failed review and never a reason to invent an
item to show work. Missing or unusable reviewer output is the opposite:
incomplete coverage, which blocks until the reviewer is rerun.

## How `/ship` converges (`review_scope: frozen`, the default)

1. **Pass 1 reviews the whole diff** against the merge base. Every finding goes
   through `gstack-review-scope classify`, which stamps it with `locus` (`diff`:
   a hunk the PR changed, with three lines of context; `outside`: anything else),
   `kind`, `blocking` and `scope`. Findings in the diff are `fix`. A blocking
   finding in code the PR did not change is `defer`: `gstack-review-scope defer`
   files it as a GitHub issue (one per finding, reused across reruns through an
   `<!-- gstack-deferred-finding: <fingerprint> -->` marker; the issue text is
   scanned like the PR body before anything is posted, so a finding that quotes a
   secret is `unfiled (publication scan refused: …)`; `unfiled (<reason>)` when
   `gh` is unavailable or its search fails; every unfiled case still exits 0)
   and the PR body lists it under `## Deferred findings`. A finding's `cause`
   (the changed line behind a defect reported elsewhere, a deleted file included)
   places it in the diff.
   Below-floor findings outside the diff are `note`, listed under `## Review notes`.
2. **Pass 2 and later review only the range since the previous pass.** Each pass
   saves its head; the next pass diffs `RANGE_BASE..HEAD` for every reviewer (the
   gate scan and QA probes keep the whole candidate) and classifies with
   `--range-base`. Only a blocking finding in that range or in the diff is `fix`;
   every below-floor finding is a `note`. A finding the diff causes in code it did
   not change names the changed line in `cause`, and the locus follows it.
3. **Three passes is the cap.** A pass that applies no edits is the exit: the
   PR ships with its deferred and noted items named in the body. A blocking
   finding still in `fix` scope on pass 3 stops the run and names the finding
   (path, severity, problem) for the owner; a fourth pass is the owner's call,
   never the loop's.

The same floor and the same `NO FINDINGS` rule apply to `/review` on its own;
its re-review loop keeps its three-cycle fix cap (`CYCLES`), and a pass that
applies no edits is its exit too.

## What the receipt records

`gstack-review-scope summary --since <REVIEW_SINCE>` reads this invocation's
review-log rows and writes the counters `gstack-ship-receipt write --review-loop`
puts in the receipt:

| Field | Meaning |
|---|---|
| `review_loop.passes` | review passes this ship ran (1 to 3) |
| `review_loop.blocking_found` | distinct blocking findings across the passes |
| `review_loop.deferred` | blocking findings in unchanged code filed as issues |
| `review_loop.noted` | below-floor findings listed in the PR body |
| `review_loop.fixed` | findings fixed in this PR |
| `review_loop.scope` | the `review_scope` the loop ran under |

The receipt's summary line prints `passes=<n> blocking_found=<k> deferred=<m>`,
which is what a scorecard tracks (target: a median of 2 passes per PR). A
receipt carried across a base merge or a test-only fix
([ship-policy.md#receipt-carry](ship-policy.md#receipt-carry)) keeps these
counters, because the reviewed product diff is unchanged.

## The scope knob

`.gstack/ship-policy.json` `review_scope` ([ship-policy.md#review-scope](ship-policy.md#review-scope)):

| Value | Pass 1 | Blocking finding in unchanged code | Pass 2+ | Cap |
|---|---|---|---|---|
| `frozen` (default) | the diff | filed as an issue, listed as deferred | the range since the previous pass, blocking only | 3 passes |
| `diff-plus-blocking` | the diff | fixed in this PR | the range since the previous pass, blocking only | 3 passes |
| `all` | everything | fixed in this PR | the whole diff, every finding | 3 fix cycles |

`diff-plus-blocking` is the fallback for a repository where deferred issues pile
up; `all` is the loop as it ran before the key existed. A value other than
`frozen` needs `min_gstack_version` at or past the release that added the key
(`REVIEW_SCOPE_KEY_VERSION` in `lib/ship-policy.ts`) so an older gstack refuses
the file by name instead of ignoring the key.

## Where this is enforced

- `scripts/resolvers/review-army.ts`: the floor and `NO FINDINGS` in every specialist and Red Team prompt (rendered into `review/sections/review-army.md` and `ship/sections/review-army.md`).
- `ship/sections/review-army.md` Step 9: passes, `RANGE_BASE`, classify, defer, render, the cap decisions; `ship/sections/adversarial.md` Step 11: the outside voice reads the same range and scopes queued fixes the same way.
- `lib/review-scope.ts`, `bin/gstack-review-scope`: `classify`, `defer`, `render`, `summary`; refusals are `REVIEW_SCOPE_INPUT` and `REVIEW_SCOPE_RANGE` ([troubleshooting.md](troubleshooting.md#review-scope-input)).
- `lib/ship-policy.ts`: the `review_scope` key and its `ship: review_scope …` consequence line.
- `lib/ship-receipt.ts`, `lib/headless-artifacts.ts`: the `review_loop` receipt object, its schema and the summary line.
