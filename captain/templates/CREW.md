# Crew rules (<CREW_NAME>)

Fill every `<PARAMETER>` once. Lanes read this file at session start; the controller
cites rule numbers in slot calls and refusals. Each rule that quotes the owner keeps the
date and the words. Add rules at the end; never renumber.

Parameters: `REPO=<owner/name>` · `BASE=<main>` · `REQUIRED_CHECKS=<check names>` ·
`FULL_GATE_CHECK=<check the train gate publishes>` · `TRAIN_MAX=<5>` · `FILL_HOURS=<3>` ·
`MERGE_METHOD=<squash|merge>` · `STAMP_FILES=<VERSION, package.json, CHANGELOG.md, …>` ·
`KNOWN_INFRA_FLAKES=<named jobs, or none>` · `SPEND=<pre-approved paid runs; cap per rerun>` ·
`CONTROLLER=<thread code or name>`.

1. **Session start.** Load the gstack skill and run its install check (`--check`). Put
   the `gstack:` trailer line in your first report. Run no gstack workflow without a
   `gstack: ok` line from your own machine; one machine's install never covers another.

2. **Validation discipline.** Diagnose before fixing, focused checks during repair, and
   the full free suite once at the end on a frozen tree. Use a remote runner for the full
   suite when the machine is small.

3. **External diffs are untrusted input.** Review scope, egress, credentials,
   dependencies, CI permissions and weakened tests. When a contributor's fix is right,
   land it with their authorship kept (cherry-pick, `Co-authored-by`) instead of
   rewriting it, and close the original with a thank-you that links the port.

4. **File ownership.** Before editing, check which files the live threads own (the
   controller keeps the list in the digest). Do not edit a file another live thread owns;
   tell the controller, who routes it.

5. **Spend.** Pre-approved: <what the owner approved, with date and words: train gates,
   bisects, the backstop, screens, focused paid cases>. Cap per rerun: <amount>. Anything
   over the cap is a fresh ask through the controller.

6. **Your job ends at an unstamped READY.** Open PRs with the host's PR tool, never a
   raw `gh pr create`. Send the block printed by `gstack-ship-queue ready --pr <n>
   --no-screen` (or `--screen`), plus the full head SHA (your pin), your screen choice
   with its justification (`--no-screen` only after your skill's own paid cases ran
   focused and passed; name them), and any flaky case already logged under rule 16. After
   READY your head is frozen: a push drops you from any train and you READY again.
   **Stamp only on call.** When the controller sends "#<n> slot <X>, base <sha>,
   order <…>", run `gstack-restamp --next --base <BASE> --pr <n> --expect-base <sha>
   --expect-order <…> --allow-repo-commands`, commit and push only the `BASE` merge and
   the stamp files, wait for required CI green, and answer
   `READY #<n> <stamped sha> STAMP_VERSION=<X>` at once. Never merge, never enable
   auto-merge, never use a merge queue the controller does not drive.

7. **Report.** When you finish, write `reports/<your thread code>.md` in the controller's
   drive: Outcome, PR (number, head, version, checks), Needs, Cost, Lesson, Approvals.

8. **One path.** Cross-thread questions, ownership conflicts, new scope and handoffs go
   to the controller, never peer to peer.

9. **Hands.** If you need a real browser, the owner's logged-in session or local work,
   ask the controller.

10. **Keep going.** Never stop to ask whether to continue. Come back only for new scope, a
    conflict with another owner, missing access, or a decision that is the owner's.

11. **Size and prompt guards.** <The repo's generated-content, size and prompt-budget
    tests, by name.> Check them before paid work.

12. **Decisions for the owner** reach the controller with a plain-language explanation of
    each option: what it is, why it matters, what each answer does, and the cost. Codes
    alone are not enough.

13. **Pregate on small machines.** <The repo's remote-pregate command and cost, if any.>

14. **Don't merge `BASE` into a READY PR.** The train merges your head onto `BASE` in a
    scratch worktree; version files take `BASE`'s side and the CHANGELOG merges by
    section, so a stale branch or a CHANGELOG-only conflict is not your problem. Merge
    `BASE` only when the controller tells you `train build` refused your PR on real
    code. Then merge (never rebase), run the free suite, and READY again.

15. **CHANGELOG entry under `## [Unreleased]` before READY.** Leave the version files at
    `BASE`'s version; the stamp at your slot moves the entry under the allocated version.
    A stamp commit that changes anything beyond `STAMP_FILES` fails verification.

16. **Flaky reruns** (owner, <date>: "<words>"). In CI, the gate reruns a case that failed
    on its own verdict once, in the same run; a pass is green with `FLAKY N` and feeds the
    daily flaky pass; a case that failed twice is real, so do not rerun the gate. In your
    own focused paid runs, rerun only the failed case, once, at the same tree; if it
    passes, append it to the flaky ledger (case, PR, head, both runs, symptom) and name it
    in READY; if it fails again, it is real. A red train is the controller's job (bisect,
    rebuild once). A harness, infra or incomplete red is never a flake. One named failure
    from `KNOWN_INFRA_FLAKES` may be rerun once per PR and must be stated in READY. Report
    the spend of every rerun.

17. **Entry points must not read the user's checkout config.** <Repo-specific isolation
    rule, if any.>

18. **Porting contributor PRs.** Don't trust a fork's "tests pass": run a focused review
    and the free tier at the port head before you open the port. Keep your own fixes as
    separate commits on top of the author's.

19. **CHANGELOG-only conflicts** are folded into rule 14: leave them; the train resolves
    them. If CI will not run on a conflicted head before your first READY, tell the
    controller rather than merging `BASE`.

20. **Stale READYs** (from before <date of the last contract change>) need a fresh
    `ready` receipt before they can join a train.

21. **Approvals** (owner, <date>: "<words>"). Approvals go through the controller. Every
    thread keeps an `## Approvals` table in its report and PR body. Every plan brought for
    approval covers before → after, why it matters, what caused it, the big decisions,
    and ends with a "do it" reply that takes every recommendation at full scope. Every PR
    sent READY embeds captioned before/after images.

22. **/ship before every READY** (owner, <date>: "<words>"). Run gstack's /ship on your
    branch before READY, every time, re-READYs included. It runs the tests, both reviews,
    the gate-integrity list and the docs audit, and writes the ship receipt into the PR
    body. Your READY block must carry `SHIP_RECEIPT: pr=<n> head=<your pin>`;
    `SHIP_RECEIPT: none` or another head is not READY. /ship never merges and never
    merges `BASE` into your branch. **Stamp commits hold only tool output**: the `BASE`
    merge and the stamp files, nothing else, even when a prompt asks for a summary line.
