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

<a id="rulings-below-the-floor"></a>
### Rulings below the floor

The floor is a test, and these classes have been put to it, each more than
once, and failed it (#3485 from the /ship of #3484, #3504 from the /ship of
#3487). A finding in one of them is a **note** from the first pass on, named
by its ruling in the PR body's `## Review notes`; it never earns a fix round
or another review pass, and the lead judgment stage drops it from the defect
count with the pointer. The floor itself does not move, so a finding that also
loses data, crosses a trust boundary or spends without a cap stays CRITICAL
whatever class it resembles.

| Ruling | What it looks like | Why it is below the floor |
|---|---|---|
| **own-artifact hardening** | A check missing between two things the repository's own tooling writes: a screen verdict not compared with the receipt it belongs to; a receipt schema that does not declare a key the writer records; a policy loader that defaults when the base branch's own file is invalid; a size read that follows a symlink inside the repository. | The only writer is the repository's maintainers through its tools; no caller inside the intended case reaches the gap, and no test fails. A writer outside that trust boundary makes it a bypass, and CRITICAL. |
| **unwired or unread** | A helper with no caller, a field written and never read, a duplicated helper, a header comment naming a step that does not run it, a key-version constant that moved before any release carried the old value. | Nothing takes the path, so nothing breaks; it is dead code to delete or wire in its own change. |
| **bounded repeat work** | A re-dispatch on every call, a redundant screen after main moves, an orphaned scratch branch, a refusal that could come one step earlier in the sequence, a settle that could wait one more check. | The operation completes, nothing is lost, and the cost is one more bounded run; uncapped spend is the sideways sweep's CRITICAL, not this class. |
| **conservative refusal** | Stale state scoped wider than its cause: a RED verdict that keeps refusing a head after main moved, a pending result that keeps refusing after it settled. | A refusal costs a rerun and never passes something wrong; a wrong pass would be the floor. |
| **artifact presentation** | A string from an artifact printed verbatim into a parsed line (whitespace, control characters); a classifier that reads a non-zero exit code beside a non-RED verdict as RED. | Display and classification of the repository's own output; it forges no parsed field. |
| **test gap** | A state-matrix cell without a test, a coverage percentage, a weak or flaky test, a fixture that shares the coordinator's environment. | Category `testing`, below the floor by definition above; a gap is work for the test audit, not a defect in the diff. |

A reviewer that wants a class promoted argues it against the floor with a
reaching input, in the finding, and the owner rules; the table records the
rulings, it does not close them.

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
2. **What comes next is the transition table below**, not "any fix earns
   another pass". A full pass after pass 1 reviews only the range since the
   previous pass: each pass saves its head, the next diffs `RANGE_BASE..HEAD`
   for every reviewer (the gate scan and QA probes keep the whole candidate) and
   classifies with `--range-base`. Only a blocking finding in that range or in
   the diff is `fix`; every below-floor finding is a `note`.
3. **Two full passes is the cap**, plus at most one fix-check. A blocking
   finding still open after the last allowed step stops the run and names the
   finding (path, severity, problem) for the owner; a third full pass is the
   owner's call, never the loop's. The cap approves nothing.

<a id="transitions"></a>
### Transitions

`gstack-review-plan` (`lib/review-depth.ts` `nextStep`) owns this table, and
/ship asks it after every step:

| The step that just finished | Next |
|---|---|
| none | full pass 1 on the whole diff |
| a full pass with no edits | done |
| a full pass that fixed a blocking finding, below the cap | full pass on the range |
| a full pass whose fix touched a gate-class path, below the cap | full pass on the range |
| a full pass that fixed only below-floor findings | one fix-check |
| a full pass at the cap that fixed a blocking finding | one fix-check |
| a full pass that leaves a blocking finding open (fixed or not) | stop: name it for the owner |
| a fix-check that found nothing blocking | done |
| a fix-check that found a blocking finding | stop: name it for the owner |

A **fix-check** is one reviewer reading the touched hunks, the fix list, the
test results and the callers of every changed symbol, at full effort. It is
logged as a `review-fix-check` row, so it never counts as a pass. No army, no
Red Team and no outside voice run on it.

The same floor and the same `NO FINDINGS` rule apply to `/review` on its own;
its re-review loop keeps its three-cycle fix cap (`CYCLES`), and a pass that
applies no edits is its exit too.

<a id="review-depth"></a>
## Review depth by diff class

`gstack-review-plan --base <base>` classifies the diff and prints the reviewers
the next step dispatches (`REVIEW_CLASS:`, `REVIEW_PLAN:`, one `DISPATCH:` per
reviewer with its effort, one `SKIP:` per reviewer left out, `--json`). A mixed
diff takes its most restrictive class; a `gstack-diff-scope` error fails closed
to code, and code with the gate scan unavailable fails closed to gate.

| Class | What it is | Pass 1 dispatches |
|---|---|---|
| **docs** | markdown no agent or gate reads: README, CHANGELOG, TODOS, how-to and explanation docs | the parent's core checklist only |
| **tests** | test files and fixtures only | core plus the testing specialist |
| **code** | everything else, including every `SKILL.md` and template, any markdown in a skill directory, `*/sections/**`, `scripts/resolvers/**`, `docs/*-policy.md`, `docs/captain.md`, `docs/unattended.md`, `docs/pregate.md`, checklists, specialists and bins | specialists by scope (as before), the native adversarial pass, the outside voice; the Red Team past 200 lines or after a CRITICAL |
| **gate** | code plus auth or migration scope, a hunk the gate scan tags (an RH rule: a relaxed threshold, a skipped test), a deleted code file, CI workflows, credential or state-root paths | code's set, plus the Red Team always, at full effort, and no hit-rate gating |

**Numbers keep the outside voice.** On a docs or tests diff the outside voice is
skipped unless the diff publishes numeric claims: `gstack-review-plan` scans the
added lines of every path for percentages, money, multipliers, durations, token
or credit counts and score, rate or speed claims (`NUMBERS: yes`), and a
claim always dispatches it. The claims' fingerprint (`fingerprint=`) is passed
back as `--reviewed-numbers`; when a later fix changes a claim, only the
outside voice reruns, on the numbers.

**The adversarial and outside voices run once per invocation** (Step 11, on the
final tree), as the last full-pass plan lists them; after they ran, decision 2
passes `--adversarial-ran` so a repeat lists them no more. Later full passes rerun the
specialists on the range only. Step 11.5 binds a planned skip through the Step 9
record's `CURRENT` freshness instead of a native record.

**Effort.** Every reviewer that can block a ship (the core checklist,
specialists, the Red Team, the native adversarial pass, fix-checks) runs at
`full` effort. Work that cannot block (the Step 7 coverage audit, the Step 8
plan-completion audit, the Step 14.5 docs audit, decision-trail reviewers,
watchers) runs at `light`: the same model at a lower reasoning effort, never a
cheaper model family. The outside voice keeps its own provider and effort
(`codex_effort`). A host that cannot set a subagent's effort runs it at its
default. `gstack-config set review_effort_tiers off` (or `--no-tiers`) runs
the audits and watchers at the host default too
([model-policy.md](model-policy.md#reasoning-effort)).

## What the receipt records

`gstack-review-scope summary --since <REVIEW_SINCE>` reads this invocation's
review-log rows and writes the counters `gstack-ship-receipt write --review-loop`
puts in the receipt:

| Field | Meaning |
|---|---|
| `review_loop.passes` | full review passes this ship ran (1 or 2; up to 3 under `review_scope: all`) |
| `review_loop.blocking_found` | distinct blocking findings across the passes |
| `review_loop.deferred` | blocking findings in unchanged code filed as issues (a Step 11 late defer, logged as a `review-late-defer` row so it never displaces the newest `review` pass, counts here and is not a pass) |
| `review_loop.noted` | below-floor findings listed in the PR body |
| `review_loop.fixed` | findings fixed in this PR |
| `review_loop.scope` | the `review_scope` the loop ran under |
| `review_loop.fix_checks` | fix-checks this ship ran (never passes) |
| `review_loop.dispatches` | reviewer dispatches by role: `specialist`, `red-team`, `adversarial-native`, `outside-voice`, `fix-check` |
| `review_loop.est_input_tokens` | prompt plus diff bytes the dispatches read, divided by 4: a relative estimate for comparing runs, not a bill |

Each review row may carry `dispatches: [{role, effort, prompt_bytes,
diff_bytes, status}]`; `summary` adds them up (older rows fall back to the
specialist stats they record). The summary line appends `fix_checks=`,
`dispatches=` and `est_input_tokens=` only when they were recorded, so an old
loop prints the old line.

The receipt's summary line prints `passes=<n> blocking_found=<k> deferred=<m>`,
which is what a scorecard tracks (target: a median of 1 pass per PR). A
receipt carried across a base merge or a test-only fix
([ship-policy.md#receipt-carry](ship-policy.md#receipt-carry)) keeps these
counters, because the reviewed product diff is unchanged.

## The scope knob

`.gstack/ship-policy.json` `review_scope` ([ship-policy.md#review-scope](ship-policy.md#review-scope)):

| Value | Pass 1 | Blocking finding in unchanged code | Pass 2+ | Cap |
|---|---|---|---|---|
| `frozen` (default) | the diff | filed as an issue, listed as deferred | the range since the previous pass, blocking only | 2 full passes + 1 fix-check |
| `diff-plus-blocking` | the diff | fixed in this PR | the range since the previous pass, blocking only | 2 full passes + 1 fix-check |
| `all` | everything | fixed in this PR | the whole diff, every finding | 3 fix cycles |

`diff-plus-blocking` is the fallback for a repository where deferred issues pile
up; `all` is the loop as it ran before the key existed. A value other than
`frozen` needs `min_gstack_version` at or past the release that added the key
(`REVIEW_SCOPE_KEY_VERSION` in `lib/ship-policy.ts`) so an older gstack refuses
the file by name instead of ignoring the key.

## Reviewer fan-out

The review army launches every selected specialist in one message so they run
in parallel; a host that caps running subagents makes that impossible past the
cap. In `/ship` the knob is a prompt flag, `--review-fanout auto|serial|parallel`
(default `auto`), read where the force flags (`--all-specialists`) are (`/review`
on its own keeps the single parallel batch: its generated SKILL.md sits at its
size pin, and a refused launch there is a failed reader, never dropped coverage):

| Value | Batches |
|---|---|
| `auto` | when the host reports fewer free subagent slots than selected specialists, batches of the free-slot count (at least one), each launched in one message, the next only after every reader of the previous one finished or is confirmed stopped; a host that reports no slot count runs one parallel batch |
| `serial` | batches of one |
| `parallel` | one batch regardless of slots; a refused launch is a failed reader, never silently dropped coverage |

Capy caps a thread at 8 running subagents, and waiting or idle ones hold a
slot, so under `auto` a nine-specialist review on an otherwise idle Capy
thread runs as one batch of 8 and one of 1 (`Fan-out: 9 specialists in 2
batches of 8`). Batching changes the order, never the set: every selected
specialist runs before the merge stage, and the Red Team's activation reads
the merged result as before.

## Two checklist rules with ids

Two findings `review/checklist.md` names by rule id so a PR body, a review log
and a later reader agree on what was flagged:

- `prereg-with-results` (Pass 1, Gate Integrity, ASK): one diff adds or changes
  an eval's preregistration (bars, arms, decoys, stop rules, a plan file) and
  also adds that eval's results, scores or verdict. The bar could have been set
  after the outcome, so the pairing is the finding. The repair is a split: the
  preregistration lands first and the results PR cites its merged commit.
- `test-keyboard-count-loop` (Pass 2, informational): a browser-driver test
  reaches an element by a counted loop of key presses and asserts on whatever
  has focus, so the count encodes today's DOM order. Locate the target by role,
  label or test id; a counted loop stays only when the count is the behavior
  under test.

<a id="porting-a-contributors-work"></a>
## Porting a contributor's work

A ported branch keeps the contributor's commits as theirs and adds the
porter's fixes on top, each crediting the original authors.
`gstack-coauthor-trailers [<range> | --base <ref>] [--message <file>]
[--exclude <email>]...` lists every distinct author of the range's commits
(default `origin/<base>..HEAD`) other than the checkout's own committer
identity, in first-appearance order, as `Co-authored-by: Name <email>` lines;
`--message <file>` adds the ones the commit message file lacks to its trailer
block (`git interpret-trailers`, pinned placement, so an existing co-author
keeps attribution), matched by
email case-folded, so running it twice changes nothing. The `COAUTHORS: <n> in
<range>` line on stderr is the receipt; `--json` prints `{ range, authors,
trailers, appended }`.

## Where this is enforced

- `scripts/resolvers/review-army.ts`: the floor and `NO FINDINGS` in every specialist and Red Team prompt (rendered into `review/sections/review-army.md` and `ship/sections/review-army.md`), and the lead judgment's "On record" line that turns a [ruled class](#rulings-below-the-floor) into a note; in `/ship` every specialist and Red Team prompt it renders carries its diff base as a literal sha the parent writes in (`DIFF_BASE=<diff-base>`: the merge base on pass 1, `RANGE_BASE` from pass 2 on), because a reviewer is its own process and never sees the parent's shell variables; the fan-out batches above.
- `ship/sections/review-army.md` Step 9: passes, `RANGE_BASE`, classify, defer, render, the cap check before any edit, the Step 11 late-defer row, scratch files under `.gstack/tmp/`, the cap decisions; `ship/sections/adversarial.md` Step 11: the outside voice reads the same range and scopes queued fixes the same way.
- `lib/review-depth.ts`, `bin/gstack-review-plan`: the diff class, the transition table, the numeric-claim scan and each role's effort tier (`test/review-depth.test.ts`, `test/review-plan-cli.test.ts`).
- `lib/review-scope.ts`, `bin/gstack-review-scope`: `classify`, `defer`, `render`, `summary` (with `fix_checks`, `dispatches`, `est_input_tokens`); refusals are `REVIEW_SCOPE_INPUT` and `REVIEW_SCOPE_RANGE` ([troubleshooting.md](troubleshooting.md#review-scope-input)).
- `lib/ship-policy.ts`: the `review_scope` key and its `ship: review_scope …` consequence line.
- `review/checklist.md`: `prereg-with-results` under Gate Integrity and `test-keyboard-count-loop` under Pass 2; `bin/gstack-coauthor-trailers` for the contributor-credit trailers of a port.
- `lib/ship-receipt-prose.ts`, `gstack-ship-receipt read --check-prose`: the body's quoted counters against the receipt (`RECEIPT_PROSE_MISMATCH`, [ship-policy.md](ship-policy.md#ship-receipt)).
- `lib/ship-receipt.ts`, `lib/headless-artifacts.ts`: the `review_loop` receipt object, its schema and the summary line.
