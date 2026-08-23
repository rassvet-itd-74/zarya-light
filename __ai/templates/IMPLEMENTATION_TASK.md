# Implementation task prompt

Use this when giving Claude Code a substantial feature.

```text
Read __ai/ROUTER.md and route this task to the minimum relevant Zarya skills.

Task:
<state the behavior to implement>

Acceptance criteria:
- <observable behavior 1>
- <observable behavior 2>
- <failure/recovery behavior>

Constraints:
- Preserve existing architecture unless repository evidence requires a change.
- Do not broadcast live transactions while implementing/testing.
- Use deterministic local tests; Sepolia smoke testing is opt-in only.

Before editing:
1. inspect the existing implementation and live contract/ABI where relevant;
2. identify any mismatch with __ai assumptions;
3. state a concise implementation plan and invariants.

Then implement the smallest coherent slice, run relevant tests, and finish with changed files, test evidence, unresolved risks, and next dependency.
```
