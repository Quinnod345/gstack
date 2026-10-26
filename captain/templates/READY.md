# READY block

Sent by the lane, as printed by `gstack-ship-queue ready --pr <n> --no-screen|--screen`,
then the lane's own lines. The controller validates every field before the pin enters
`train build`. A missing or wrong field goes back to the lane, never into a train.

```text
READY #<n> <sha40> STAMP_VERSION=unstamped
base: <BASE> @ <base sha12>
ci: passed=<k> failed=0 pending=0 (<REQUIRED_CHECKS names>)
PREGATE: pass tree=<tree12> (remote lanes cleared: <run urls>)
gate: <skill's own cases: <case ids> passed | screen requested>
SHIP_RECEIPT: pr=<n> head=<sha40>
screen: <--no-screen (cases above passed focused) | --screen (reason)>
READY_RECEIPT: <path written by the tool>
flaky: <none | case, both run ids, logged in the ledger on <date>>
Head frozen from now on; a push drops this PR from any train and I will READY again.
```

Optional lines a crew's rules file may require:

```text
gate_run: <run id> tree=<tree12>        # when lanes gate on their own machines
closes: #<issue>
image: <URL of the key before/after image>
```

Refuse (send back) when: the SHA is short or a fork head; `SHIP_RECEIPT` is `none` or its
head is not the pin; a required check is pending, failed, or on another head; PREGATE is
not `pass` for this tree; `--no-screen` names no cases; a flaky case is not in the
ledger; the PR state is "green" but no block was sent; the evidence offered is a cheap
tier.

After the slot call the lane answers with the stamped head:

```text
READY #<n> <stamped sha40> STAMP_VERSION=<X>
```
