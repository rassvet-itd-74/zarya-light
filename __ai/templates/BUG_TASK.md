# Bug-fix task prompt

```text
Read __ai/ROUTER.md and route this bug to the relevant Zarya skills.

Observed behavior:
<what happened>

Expected behavior:
<what should happen>

Reproduction/evidence:
<logs, tx hash, batch id, fixture, test, or steps>

First reproduce or identify the violated invariant. Do not patch symptoms by adding blind retries or suppressing errors. Trace issued template -> returned form -> intent -> local job state -> transaction/receipt -> on-chain state as applicable. Implement the smallest root-cause fix and add a regression test that fails before the fix and passes after it.
```
