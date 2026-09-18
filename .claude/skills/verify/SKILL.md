---
name: verify
description: Run this project's full verification gate (typecheck + test + desktop build) and report a concise pass/fail summary. Use before reporting any AI Council change as done, or whenever the user asks to verify/check the project builds and tests pass.
---

# Verify

AI Council's standing rule (see `CLAUDE.md`): every change is expected to leave `npm run typecheck && npm test` green plus a successful `npm run build --workspace=@ai-council/desktop` before being reported done.

Run, in order, stopping at the first failure and reporting it (don't run later steps against a known-broken earlier one):

```bash
cd C:\Users\Andre\Desktop\ai-council
npm run typecheck
npm test
npm run build --workspace=@ai-council/desktop
```

Notes:
- `npm test` is slow (multiple minutes) — most suites spawn real child processes (real git worktrees, real fake-CLI fixtures) rather than mocking. This is expected, not a hang.
- If only one package changed, `npm run typecheck --workspace=@ai-council/<pkg>` and `npm test --workspace=@ai-council/<pkg>` are faster for a quick check mid-task — but run the full three-step sequence above before calling anything done, since packages depend on each other.
- Report which of the three steps passed/failed, not just a final verdict — a typecheck failure and a test failure need different fixes.
