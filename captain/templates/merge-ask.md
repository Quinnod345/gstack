# Merge ask (shape C)

What every PR body carries when it is READY, and what the controller's merge report to
the owner shows. /ship writes the PR body in this shape on Capy; the controller checks
it before training the PR.

```text
## What changed
![<caption: what changed and why>](<before/after image URL from the host's PR asset tool>)
<one to three images, highest-signal first; a collapsed text version under each>

## Why
<the cause and the user-visible effect, two or three sentences>

## Approvals
<the table from gstack-approvals render>

## Evidence
checks: <REQUIRED_CHECKS> green at <sha40> · gate/train: <GREEN with FLAKY N | screen result> ·
flaky: <cases, both runs, ledger date | none> · pregate: pass tree=<tree12>
```

The controller's merge report: the PR link, the key image inline, the version it will
take, the slot, and the one-word reply if a decision is attached.
