import { mkdir } from 'node:fs/promises'
import type { CouncilParticipant, CouncilParticipantEvent, ProviderId } from '@ai-council/shared'
import type { CodingExecutor, CodingExecutorEvent } from '@ai-council/coding'
import { isGitRepo, snapshotWorkspace, verifyWorkspaceUnchanged } from '@ai-council/coding'

function mapExecutorEvent(
  logicalProvider: ProviderId,
  event: CodingExecutorEvent
): CouncilParticipantEvent | undefined {
  switch (event.type) {
    case 'start':
      return { type: 'start', runId: event.taskId }
    case 'status':
      return { type: 'status', message: event.message }
    case 'text':
      return { type: 'text_delta', text: event.text }
    case 'warning':
      return { type: 'warning', message: event.message }
    case 'file_change':
      return {
        type: 'warning',
        message: `Council-Modus (Read-only erzwungen): unerwartete Dateiänderung beobachtet (${event.changeType}): ${event.path}`
      }
    case 'command':
      return {
        type: 'warning',
        message: `Council-Modus (Read-only erzwungen): unerwarteter Befehl beobachtet: ${event.command}`
      }
    case 'test_result':
      // Not relevant to a council seat's advisory role, and no executor
      // emits it today (see packages/coding's contract doc comment).
      return undefined
    case 'done': {
      const usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {}
      for (const field of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
        const value = event[field]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[field] = value
      }
      return { type: 'done', result: { text: event.summary,
        ...(Object.keys(usage).length ? { usage } : {}) } }
    }
    case 'error':
      // CodingExecutorEvent's error `code` is a free-form, executor-specific
      // string (e.g. an exit code) - not the same vocabulary as
      // CouncilErrorCode, so it's folded into the message instead of cast.
      return {
        type: 'error',
        error: {
          providerId: logicalProvider,
          code: 'unknown',
          message: event.code ? `${event.message} (code: ${event.code})` : event.message,
          retryable: false
        }
      }
  }
}

/**
 * Overrides the default read-only tool list (Read/Glob/Grep) for Claude
 * Code specifically, adding the read-only network tools - caught live in
 * two rounds: first WebSearch ("3 Werkzeug-Aufruf(e) wurden verweigert:
 * WebSearch"), then WebFetch, both because the default read-only tier's
 * allowlist has no network tools at all. Neither ever touches the
 * filesystem, so allowing them doesn't weaken the actual invariant here
 * (never mutate the repo) - both tool names are confirmed real by Claude
 * Code's own denial messages, not guessed. `allowedTools` is a documented
 * Claude-Code-specific override (packages/coding's CodingTaskSpec) that
 * Codex/Antigravity both ignore entirely, so this is a no-op for them, not
 * a behavior change.
 */
const COUNCIL_READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']

/**
 * Wraps a CodingExecutor as a read-only council participant - an already
 * locally-authenticated CLI subscription standing in for a paid API council
 * seat. permissionTier is hardcoded to 'read-only' on every call, the same
 * technique @ai-council/coding's runImplementAndReview already uses to force
 * its reviewer stage read-only regardless of the caller's own tier
 * (runReviewStage's hardcoded 'read-only' literal). Only that one technique
 * transfers - that pipeline's separate diff-file-in-workingDirectory trick
 * is safe there only because it owns a disposable git worktree end-to-end;
 * it is neither needed nor reproduced here.
 *
 * Read-only safety rests almost entirely on how each CLI translates
 * permissionTier: 'read-only' into a real restriction: a genuine tool
 * allowlist for Claude Code, the CLI's own read-only sandbox default for
 * Codex - both hard technical restrictions. Antigravity has no documented
 * read-only flag; it relies on an *observed*, non-contractual default
 * behavior when spawned non-interactively (verified live: mutating actions
 * get auto-denied with no TTY to approve them, rather than hanging or
 * silently succeeding) - a future CLI update could change that default
 * without anything here catching it. The git-diff check below is a
 * best-effort backstop, not a guarantee: it scans the whole working
 * directory, not just files the agent touched, so an unrelated concurrent
 * change during the same call can also trigger it.
 */
export function toAgentCouncilParticipant(
  logicalProvider: ProviderId,
  executor: CodingExecutor,
  workingDirectory: string
): CouncilParticipant {
  return {
    id: logicalProvider,
    backend: 'local_agent',
    capabilities: () => ({ streaming: true, tools: false, vision: false }),
    async *generate(request, options): AsyncGenerator<CouncilParticipantEvent> {
      await mkdir(workingDirectory, { recursive: true })

      const prompt = request.systemInstructions
        ? `${request.systemInstructions}\n\n${request.messages.map((m) => m.content).join('\n\n')}`
        : request.messages.map((m) => m.content).join('\n\n')

      const repoPresent = await isGitRepo(workingDirectory)
      const baseline = repoPresent ? await snapshotWorkspace(workingDirectory) : undefined

      let handle: ReturnType<CodingExecutor['startTask']>
      try {
        handle = executor.startTask(
          { prompt, workingDirectory, permissionTier: 'read-only', allowedTools: COUNCIL_READONLY_TOOLS },
          { signal: options?.signal }
        )
      } catch (err) {
        // startTask() can throw synchronously before ever returning a
        // handle - e.g. Antigravity's own prompt-length check (it has no
        // stdin path, unlike Claude Code/Codex, so a long Council prompt
        // hits Windows' command-line limit). Left uncaught, this escaped
        // the whole generator and crashed the entire multi-agent Council
        // merge for every participant, not just this one - caught live
        // during a real taskgraph-generation run. A participant that can't
        // even start must fail its own turn the same way a mid-stream
        // executor error already does, not take the others down with it.
        yield {
          type: 'error',
          error: { providerId: logicalProvider, code: 'unknown', message: err instanceof Error ? err.message : String(err), retryable: false }
        }
        return
      }

      try {
        for await (const event of handle.events) {
          const mapped = mapExecutorEvent(logicalProvider, event)
          if (mapped) yield mapped
        }
      } finally {
        // Runs regardless of whether the loop above ended via `done` or
        // `error` - a partial write before a failure must still be caught.
        if (repoPresent && baseline) {
          const decision = await verifyWorkspaceUnchanged(baseline, workingDirectory)
          if (decision.outcome === 'deny') {
            yield {
              type: 'policy_violation',
              message:
                `COUNCIL_POLICY_VIOLATION: ${decision.reason} Diese Änderung wurde nicht übernommen - falls sie aus einer anderen, unabhängigen Quelle stammt (z. B. einem parallelen Build), ist das ein Fehlalarm, aber sie wird sicherheitshalber immer gemeldet.`
            }
          } else if (decision.toleratedTransient) {
            // The run is allowed to proceed (the deviation was gone by the
            // retry), but stay visible instead of vanishing silently - a
            // write that self-reverts within the retry window is otherwise
            // indistinguishable from a benign straggler.
            yield {
              type: 'warning',
              message: `Vorübergehende Arbeitsverzeichnis-Abweichung toleriert (verschwand vor der Nachprüfung): ${decision.toleratedTransient}`
            }
          }
        }
      }
    }
  }
}
