# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AI Council is an Electron/TypeScript desktop app for orchestrating Claude, Codex (ChatGPT), Gemini and Grok both as API-based discussion participants (Council/Compare/Team) and as real, locally-authenticated CLI coding agents running a full "Spec → Council → TaskGraph → Execution → Release" engineering pipeline. See `docs/vision-gap-analysis.md` for the product vision, current gap analysis against it, and the milestone roadmap (M1–M6) — read this before proposing new architecture.

## Commands

npm workspaces monorepo (`packages/*`, `apps/*`), no separate install step per package — always run `npm install` at the repo root.

- `npm run typecheck` — typechecks every workspace (`tsc --noEmit`, no emit, fast).
- `npm test` — runs every workspace's Vitest suite. **Slow (multiple minutes)** — most tests spawn real child processes (real `git` worktrees in temp dirs, real fake-CLI fixture scripts) rather than mocking, so they exercise real spawn/ENOENT/timeout behavior. Don't shorten iteration loops by mocking these away.
- `npm test --workspace=@ai-council/coding` (or any other package name) — one workspace's suite only.
- `npx vitest run path/to/file.test.ts` — one file. Add `-t "substring of the test name"` to run a single test/describe block.
- `npm run dev` — launches the Electron app (`apps/desktop`) for interactive use — use this to actually see a UI change before calling it done, not just the test suite.
- `npm run build` — production build of the desktop app only (`electron-vite build`).
- `npm run dist --workspace=@ai-council/desktop` — packages the app for distribution (`electron-builder`), per `apps/desktop/electron-builder.yml`. Does **not** publish - it only writes local files under `apps/desktop/dist/`.

No linter/formatter is configured (no ESLint/Prettier config in the repo).

## Releasing an update

The app auto-updates itself against GitHub Releases on `safetraliasoftware/ai-council` (`apps/desktop/src/main/auto-updater.ts`, wraps `electron-updater`; no-ops outside a packaged build). To ship a new version:

1. Bump `apps/desktop/package.json`'s `version` (SemVer — `electron-updater` compares this against the latest published GitHub release tag).
2. Commit and push.
3. Publish the build. `gh auth token` reuses the already-authenticated `gh` CLI session's token (has `repo` scope) instead of minting a separate one:
   ```bash
   GH_TOKEN=$(gh auth token) npm run dist --workspace=@ai-council/desktop -- --publish always
   ```
4. **Verify there's exactly one release for the new tag, not two.** Caught live on the very first release: the `nsis` and `portable` targets each raced to create the GitHub release for a brand-new tag, landing two separate draft releases with the assets split between them instead of one. Check with:
   ```bash
   gh api repos/safetraliasoftware/ai-council/releases --jq '.[] | {tag_name, draft, assets: [.assets[].name]}'
   ```
   If duplicated: `gh release delete <tag> --yes` removes one, then `gh release upload <tag> <missing-file>` adds whatever asset the surviving release is missing (all four expected: the NSIS setup `.exe`, its `.blockmap`, the portable `.exe`, and `latest.yml`). `releaseType: release` in `electron-builder.yml` already avoids the separate "stuck in draft" problem — this dedup check is the one remaining manual step.

This is a manual, deliberate process for every release — not automated by any script in this repo.

## Package layering

Dependency direction is strict and worth knowing before adding an import — `packages/coding` and `packages/task-graph` are leaves with **zero internal dependencies** (coding depends only on `cross-spawn`); everything else builds on top:

```
shared, task-graph        (no internal deps — base contracts / pure DAG domain)
  ├─ providers             (+ shared: API-based AIProvider adapters — Anthropic/OpenAI/Google SDKs)
  ├─ project-domain        (+ shared, task-graph: engineering domain rules/gates)
  └─ coding                (no internal deps: CLI executor adapters, verification, git worktrees, policy)
      └─ council-participants (+ shared, coding: wraps a CodingExecutor as a Council seat)
council-core               (+ shared: Council/Compare/Team orchestration, provider-agnostic)
apps/desktop                (+ everything: Electron main/preload/renderer)
```

When something needs to be shared between `coding` and a package that doesn't depend on it (e.g. `project-domain`), prefer a **structurally-compatible type** (same shape, no import) over adding a new cross-package dependency edge — see `PolicyDecision` (`packages/coding/src/policy/policy-decision.ts`) vs. `checkScope`'s return type in `packages/project-domain/src/engineering.ts` for the established pattern.

## Architecture

**`ProjectEngine`** (`apps/desktop/src/services/project-engine.ts`) is the host-independent core of the whole execution pipeline — a plain class taking an `EngineeringPorts` object (graph/spec storage, executor lookup, council callback, event emission) in its constructor. `apps/desktop/src/main/task-graph-execution-ipc.ts` wires the real Electron-backed ports; `apps/desktop/src/main/__tests__/project-engine.test.ts` wires fake in-memory ones — no Electron needed to test the entire attempt/review/integration/release state machine. Read this file's `EngineeringPorts` interface first when touching execution logic.

**Task attempts are a state machine**, not a single "running" flag: `TaskAttempt.status` moves through `running → review → accepted | failed | discarded | escalated`, plus two human-in-the-loop pause states, `awaiting_permission` (an agent's tool call was denied; human grants/denies elevation to permission tier `'full'`) and `awaiting_install` (a verification command's executable is missing — `ENOENT`; human approves/edits a suggested install command). Both pause states resolve via an in-memory `Map<key, resolver>` on `ProjectEngine` (`permissionRequests`/`installRequests`) — deliberately **not** persisted; `get()` treats one abandoned across a restart the same as an abandoned `running` attempt (→ `interrupted`). Each retry is a brand-new attempt (new id, new git worktree via `createWorktree`); old attempts and their evidence are kept, never overwritten.

**Everything is worktree-isolated**: a task attempt's implementer/reviewer work happens in its own git worktree; only after verification + review pass does it merge into a separate project-wide *integration* worktree (re-verified there too); only after `finalReview()`'s council + human release gate does the source branch fast-forward. Nothing pushes or deploys — release is the last step this app performs.

**Two kinds of Council seat**: API-based (`packages/providers`, wraps the provider SDKs directly) and local-agent-based (`toAgentCouncilParticipant` in `packages/council-participants/src/agent-participant.ts`, wraps a `CodingExecutor` running read-only). `createParticipantFactory` (`apps/desktop/src/main/participant-factory.ts`) resolves a `'local' | 'api' | 'auto'` backend choice per provider, grounding local-agent seats in a real project directory when one exists (not the scratch dir) so they can actually read the project's files.

**`PermissionTier` (`'read-only' | 'read-write' | 'full'`) is not a unified mechanism** — each of the four CLI executors (`packages/coding/src/executors/{claude-code-cli,openai-codex-cli,google-antigravity-cli,grok-build-cli}.ts`) translates it into a completely different concrete CLI mechanism (an `--allowedTools` allow-list, a `--sandbox` level, or a blanket `--dangerously-skip-permissions` flag). Don't try to unify this translation — it was deliberately left executor-specific (see the "Nicht Teil dieser Änderung" note in the policy-engine work) since the CLIs genuinely don't share a vocabulary here.

**Specs are event-sourced, task graphs are not.** `ProjectSpecification`/`ChangeRequest` are appended to a per-project event log (`apps/desktop/src/main/project-event-log.ts`, replayed via `replayProject`/`replayChangeRequests`) with a real version/supersede chain. `TaskGraphSnapshot` is replaced wholesale on regeneration — a deliberate simplicity choice (see the comment on `TaskGraphSnapshot` in `packages/project-domain/src/types.ts`), not an oversight; don't assume task-graph history is replayable the way spec history is.

**ChangeRequest → targeted revalidation** (`applyChangeRequest()` in `project-engine.ts`): invalidates hard-dependent tasks with a fresh Council-generated replacement (possibly several replacements per invalidated task — `replacedByTaskId` is an array), marks soft-dependent tasks for revalidation under their *same* attempt id, and is crash-safe (checks `graph.specVersion` against `cr.resultingSpecVersion` to detect and resume a partially-applied migration instead of duplicating replacement tasks).

## Conventions specific to this project

- **Never guess a CLI's exact flags, output format, or behavior.** Every CLI-integration claim in this codebase (stream-json shapes, sandbox flag semantics, `winget` package IDs) was verified by actually running the tool live before being coded against — several past bugs traced directly to skipping this. Prefer spawning the real CLI / reading its own `--help` or source over recalling training data.
- **Architectural/multi-file changes go through plan mode first**, not straight to edits — this repo has repeatedly needed real design tradeoffs (see any "Nicht Teil dieser Änderung" section in recent plan files) that are easy to get wrong by starting to code immediately.
- Every change is expected to leave `npm run typecheck && npm test` green plus a successful `npm run build --workspace=@ai-council/desktop` before being reported done.
- The product is meant for many end users, not just power users of this one instance — don't leave a superseded UI path half-gutted "just in case"; retire or fully repurpose it.
