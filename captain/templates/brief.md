# Brief

Sent by the controller when a lane starts, and again when a lane takes on scope its brief
did not name. The lane reads the rules file first, then this. Everything in angle brackets
is filled by the controller; `Plan:` says whether the lane plans first
(`docs/captain.md`, Plan before build).

```text
Lane: <thread code> · Controller: <CONTROLLER> · Rules: <drive>/CREW.md · Base: <BASE>
Owns: <the files and directories this lane may edit; everything else is routed through the controller>
Do not touch: <files other live lanes own, each with its lane>
Plan: required | approved: <autoplan run id> | exempt: <reason from the exemption list>
Spend cap: <focused paid runs per PR, from SPEND>

1. Plan (when Plan: required). Install for autoplan, write the plan with its
   ## Before → after, ## Why it matters, ## What caused this work, ## Big decisions and
   ## Implementation plan sections, and run
   gstack-autoplan next --out <run dir> --plan <plan.md> <scope flags> sized to this brief
   (a one-file fix: --no-ui --no-dx --max-rounds 1 --spend-cap <small>). At the gate send
   me the output of gstack-owner-brief render --captain --out <run dir> whole, as a
   needs-you report. Build nothing yet.
2. Build after the word. I bring the owner's exact words back. Answer them into the run
   (gstack-autoplan answer … --by agent:<your thread> --owner-reply "<their words>"),
   incorporate every accepted plan change (revise), finish every reopened phase, and start
   product edits only when the run reports APPROVED. Then
   gstack-approvals import --autoplan <run dir> --by "<owner> (via <controller>)".
   New scope you take on part-way goes back to step 1 with its own plan.
3. Ship. CHANGELOG entry under [Unreleased]; GUARD_CHECKS, pregate and /ship at the final
   head; one unstamped READY block (captain/templates/READY.md) to me; the PR body carries
   gstack-approvals render. Never merge; stamp only on my slot call.

Done when: the READY block is sent at a frozen head, reports/<thread code>.md is written,
and its Approvals table carries the plan approval row (the owner's words, the date) or the
Plan: exempt reason.
```

A lane whose brief says `approved: <run>` starts at step 2 with that run; a lane whose brief
says `exempt:` starts at step 3. A brief with no `Plan:` line reads as `Plan: required`.
