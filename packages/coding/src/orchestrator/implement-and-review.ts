import { randomUUID } from 'node:crypto'
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CodingExecutor, CodingExecutorEvent, PermissionTier } from '../contracts'
import { captureGitDiff, type GitDiffResult } from '../workspace/git-diff'

/**
 * Orchestrates steps 2-5 of the multi-agent coding workflow: one executor
 * implements, a second (different) executor reviews the resulting git
 * diff, the first executor addresses the review findings, and the second
 * executor checks that fix before the workflow ends - a review step that
 * never re-checks its own feedback would let a wrong or incomplete fix
 * through unnoticed. The exact stages that run are configurable via
 * `PipelineConfig` (a fixed toolbox - review+fix can be skipped entirely,
 * repeated once more, and the final check made optional - not a general
 * branching/condition engine). Deliberately stops there for now - build/
 * test is left to the executors' own shell access (both already do this
 * unprompted when relevant), and Council synthesis / merge approval are
 * separate, UI-level concerns that don't belong in this package.
 *
 * Lives in packages/coding, not council-core, because this orchestrates
 * CodingExecutors (agentic runtimes), not AIProviders (single model
 * calls) - the same separation of concerns that keeps council-core free
 * of filesystem/session concepts.
 */

export type WorkflowStage = 'implement' | 'review' | 'fix' | 'review2' | 'fix2' | 'finalReview'

export type WorkflowEvent =
  | { kind: 'stage_started'; stage: WorkflowStage }
  | { kind: 'executor_event'; stage: WorkflowStage; event: CodingExecutorEvent }
  | { kind: 'diff_captured'; stage: WorkflowStage; diff: GitDiffResult }
  | { kind: 'workflow_done'; success: boolean; reason?: string; noChanges?: boolean }

/**
 * A fixed toolbox of optional stages, not a general graph/condition engine -
 * deliberately scoped down from that. Every field defaults to the original
 * fixed 4-stage behavior (implement -> review -> fix -> finalReview) when
 * omitted, so existing callers/specs are unaffected.
 */
export interface PipelineConfig {
  /** Off = implement only, nothing else runs (no review, no fix, no finalReview). */
  reviewAndFix?: boolean
  /** One more review+fix cycle after the first, before any final check. Ignored if reviewAndFix is off. */
  secondReviewRound?: boolean
  /** A final read-only check of the fix(es) themselves. Ignored if reviewAndFix is off. */
  finalReview?: boolean
}

export interface ImplementAndReviewSpec {
  task: string
  workingDirectory: string
  implementer: CodingExecutor
  reviewer: CodingExecutor
  /** Permission tier for the implementer/fixer. The reviewer is always read-only - a reviewer's job is to look, not touch. */
  permissionTier?: PermissionTier
  pipeline?: PipelineConfig
}

export interface ImplementAndReviewOptions {
  signal?: AbortSignal
}

export interface ImplementAndReviewHandle {
  workflowId: string
  events: AsyncIterable<WorkflowEvent>
}

/**
 * Guardrail prepended to every implement/fix-stage prompt. Caught live: an
 * executor decided to run the full test suite before touching any code,
 * hit an unrelated pre-existing corrupted Gradle cache on the user's
 * machine, and spent the whole run trying to repair the build environment
 * instead of doing the actual task. Scoping the prompt down front cuts off
 * that class of derailment for any executor, not just the one that hit it.
 */
const SCOPE_GUARDRAIL =
  'Wichtig: Ändere nur, was für diese Aufgabe nötig ist. Räume keine Build-/Dependency-Caches auf, installiere/aktualisiere keine Abhängigkeiten und lass keine volle Testsuite laufen, es sei denn die Aufgabe verlangt das ausdrücklich. Bei einem Umgebungsproblem, das nichts mit der Aufgabe zu tun hat: kurz erwähnen und nicht reparieren.'

function buildImplementPrompt(task: string): string {
  return [SCOPE_GUARDRAIL, task].join('\n\n')
}

/**
 * Filename (relative to the project working directory) the review-stage
 * diff is written to. See buildReviewPrompt() for why this exists instead
 * of inlining the diff.
 */
const REVIEW_DIFF_FILENAME = '.ai-council-review.diff'

/**
 * Writes the diff to a real file instead of inlining it in the prompt, and
 * points the reviewer at it. Caught live: a review-stage prompt embedding
 * a real diff blew past the reviewer CLI's command-line length limit
 * ("Die Befehlszeile ist zu lang.") and failed the whole workflow. This
 * isn't specific to one CLI/shell - both Windows' cmd.exe (~8191 chars, hit
 * whenever a target is an npm .cmd shim) and the raw CreateProcess limit
 * (~32767 chars) apply to arguments regardless of how carefully they're
 * escaped, and a real diff has no bounded size. Every executor already has
 * file-reading tools, so handing over a path is both more robust and
 * requires no per-CLI stdin/flag support to verify. The file is written
 * inside the project directory (not os.tmpdir()) because at least one
 * executor (Antigravity) has a hardcoded read boundary that blocks paths
 * under AppData - the project directory is already inside its granted
 * workspace. Deleted again right after the review stage so it never shows
 * up in the final diff.
 */
function buildReviewPrompt(task: string, diff: GitDiffResult): string {
  const fileList = diff.files.map((f) => `${f.path} (${f.status})`).join(', ') || '(keine)'
  const diffSection = diff.diff.trim()
    ? `Der vollständige Git-Diff steht in der Datei "${REVIEW_DIFF_FILENAME}" im Arbeitsverzeichnis - lies sie zuerst, bevor du bewertest. (Nicht direkt in diesem Prompt enthalten, um Kommandozeilen-Längenlimits zu vermeiden.)`
    : 'Git-Diff: (kein Diff für bereits versionierte Dateien - nur neue, unversionierte Dateien wie oben gelistet)'
  return [
    `Ein anderes Coding-Tool hat gerade folgende Aufgabe bearbeitet:\n${task}`,
    `Geänderte/neue Dateien: ${fileList}`,
    diffSection,
    'Deine Aufgabe: Prüfe diesen Diff kritisch. Suche nach fachlichen Fehlern, Sicherheitsproblemen, fehlenden Tests und Abweichungen von der ursprünglichen Aufgabe. Fasse deine Findings klar und konkret zusammen (Datei, Zeile falls möglich, Problem). Wenn alles in Ordnung ist, sag das auch ausdrücklich - erfinde keine Probleme.'
  ].join('\n\n')
}

function buildFixPrompt(task: string, reviewFindings: string): string {
  return [
    SCOPE_GUARDRAIL,
    `Ursprüngliche Aufgabe:\n${task}`,
    `Ein zweites Coding-Tool hat deine Änderung geprüft und dieses Feedback gegeben:\n${reviewFindings}`,
    'Behebe die berechtigten Punkte aus dem Feedback. Wenn ein Punkt aus dem Feedback nicht zutrifft oder falsch ist, ändere dafür nichts und erkläre kurz warum.'
  ].join('\n\n')
}

/**
 * Verifies the fix, instead of trusting it blindly - a "Korrektur" step
 * that addresses review feedback can itself be wrong, incomplete, or
 * introduce something new; nothing else in this pipeline checked that
 * before the workflow ended. The diff is handed over via runReviewStage's
 * file mechanism, same as the first review, for the same reason: a real
 * diff has no bounded size, so it can't safely be a CLI argument.
 */
function buildFinalReviewPrompt(task: string, firstReviewFindings: string, diff: GitDiffResult): string {
  const fileList = diff.files.map((f) => `${f.path} (${f.status})`).join(', ') || '(keine)'
  const diffSection = diff.diff.trim()
    ? `Der vollständige, aktuelle Git-Diff (nach der Korrektur) steht in der Datei "${REVIEW_DIFF_FILENAME}" im Arbeitsverzeichnis - lies sie zuerst, bevor du bewertest.`
    : 'Git-Diff: (keine Änderungen gegenüber dem letzten Commit)'
  return [
    `Ursprüngliche Aufgabe:\n${task}`,
    `Dein vorheriges Review hatte folgendes Feedback:\n${firstReviewFindings}`,
    `Ein Coding-Tool hat daraufhin eine Korrektur vorgenommen. Geänderte/neue Dateien: ${fileList}`,
    diffSection,
    'Deine Aufgabe: Prüfe, ob dein vorheriges Feedback angemessen behoben wurde und ob die Korrektur neue Probleme eingeführt hat. Sei konkret (Datei, Zeile falls möglich). Wenn alles in Ordnung ist, sag das ausdrücklich.'
  ].join('\n\n')
}

/**
 * Writes `diff` to REVIEW_DIFF_FILENAME (if non-empty) for the duration of
 * running `stage`, then always deletes it again - shared by both review
 * passes (post-implement and post-fix) so the file never lingers between
 * runs and never shows up in a later diff capture. See buildReviewPrompt's
 * doc for why the diff goes through a file instead of the prompt text.
 */
async function* runReviewStage(
  stage: WorkflowStage,
  reviewer: CodingExecutor,
  prompt: string,
  diff: GitDiffResult,
  workingDirectory: string,
  signal: AbortSignal | undefined,
  onResult: (result: { summary: string; ok: boolean }) => void
): AsyncGenerator<WorkflowEvent> {
  const diffPath = join(workingDirectory, REVIEW_DIFF_FILENAME)
  if (diff.diff.trim()) await writeFile(diffPath, diff.diff, 'utf-8')
  try {
    yield* runStage(stage, reviewer, prompt, workingDirectory, 'read-only', signal, onResult)
  } finally {
    await rm(diffPath, { force: true })
  }
}

/**
 * Runs one executor's task to completion, forwarding its events tagged
 * with the given stage, and returns its final text (from the `done`
 * event's summary) plus whether it completed without error.
 */
async function* runStage(
  stage: WorkflowStage,
  executor: CodingExecutor,
  prompt: string,
  workingDirectory: string,
  permissionTier: PermissionTier | undefined,
  signal: AbortSignal | undefined,
  onResult: (result: { summary: string; ok: boolean }) => void
): AsyncGenerator<WorkflowEvent> {
  yield { kind: 'stage_started', stage }

  const handle = executor.startTask({ prompt, workingDirectory, permissionTier }, { signal })
  let summary = ''
  let ok = true
  for await (const event of handle.events) {
    yield { kind: 'executor_event', stage, event }
    if (event.type === 'done') summary = event.summary
    if (event.type === 'error') ok = false
  }
  onResult({ summary, ok })
}

export function runImplementAndReview(
  spec: ImplementAndReviewSpec,
  options?: ImplementAndReviewOptions
): ImplementAndReviewHandle {
  const workflowId = randomUUID()
  const signal = options?.signal

  async function* run(): AsyncGenerator<WorkflowEvent> {
    const reviewAndFix = spec.pipeline?.reviewAndFix ?? true
    const secondReviewRound = spec.pipeline?.secondReviewRound ?? false
    const wantFinalReview = spec.pipeline?.finalReview ?? true

    // Step 2: implement
    let implementResult = { summary: '', ok: true }
    yield* runStage(
      'implement',
      spec.implementer,
      buildImplementPrompt(spec.task),
      spec.workingDirectory,
      spec.permissionTier,
      signal,
      (r) => (implementResult = r)
    )
    if (signal?.aborted) {
      yield { kind: 'workflow_done', success: false, reason: 'Abgebrochen.' }
      return
    }
    if (!implementResult.ok) {
      yield { kind: 'workflow_done', success: false, reason: 'Implementierung ist fehlgeschlagen.' }
      return
    }

    let latestDiff = await captureGitDiff(spec.workingDirectory)
    yield { kind: 'diff_captured', stage: 'implement', diff: latestDiff }
    if (!latestDiff.hasChanges) {
      // Not a failure - the implementer likely just answered/analyzed
      // without changing code (e.g. an open-ended "where's room for
      // improvement" task). `noChanges: true` lets the UI show this as a
      // normal outcome, not an error.
      yield {
        kind: 'workflow_done',
        success: false,
        noChanges: true,
        reason:
          'Keine Dateiänderungen erkannt. Vermutlich war die Aufgabe eine Analyse-/Planungsfrage statt eines konkreten Umsetzungsauftrags - für sowas eignet sich der Coding-Tab (mit Nachfassen-Funktion) besser. Sobald klar ist, was zu tun ist, hier mit einer konkreten Aufgabe erneut starten.'
      }
      return
    }

    if (!reviewAndFix) {
      yield { kind: 'workflow_done', success: true }
      return
    }

    // Steps 3-4 (and, if secondReviewRound is on, once more as review2/fix2):
    // review (always read-only) -> fix. Same pair of stages run twice with
    // different tags rather than a generic loop-with-conditions engine -
    // that's the "fixed toolbox, no free branching" scope for this feature.
    let latestReviewFindings = ''
    const rounds: Array<{ reviewStage: WorkflowStage; fixStage: WorkflowStage }> = [
      { reviewStage: 'review', fixStage: 'fix' }
    ]
    if (secondReviewRound) rounds.push({ reviewStage: 'review2', fixStage: 'fix2' })

    for (const round of rounds) {
      let reviewResult = { summary: '', ok: true }
      yield* runReviewStage(
        round.reviewStage,
        spec.reviewer,
        buildReviewPrompt(spec.task, latestDiff),
        latestDiff,
        spec.workingDirectory,
        signal,
        (r) => (reviewResult = r)
      )
      if (signal?.aborted) {
        yield { kind: 'workflow_done', success: false, reason: 'Abgebrochen.' }
        return
      }
      if (!reviewResult.ok) {
        yield { kind: 'workflow_done', success: false, reason: 'Review ist fehlgeschlagen.' }
        return
      }
      latestReviewFindings = reviewResult.summary

      let fixResult = { summary: '', ok: true }
      yield* runStage(
        round.fixStage,
        spec.implementer,
        buildFixPrompt(spec.task, latestReviewFindings),
        spec.workingDirectory,
        spec.permissionTier,
        signal,
        (r) => (fixResult = r)
      )
      if (signal?.aborted) {
        yield { kind: 'workflow_done', success: false, reason: 'Abgebrochen.' }
        return
      }
      if (!fixResult.ok) {
        yield { kind: 'workflow_done', success: false, reason: 'Korrektur ist fehlgeschlagen.' }
        return
      }

      latestDiff = await captureGitDiff(spec.workingDirectory)
      yield { kind: 'diff_captured', stage: round.fixStage, diff: latestDiff }
    }

    if (wantFinalReview) {
      // Final review - checks the fix(es) themselves, instead of trusting
      // them blindly. Always read-only, same as every other review. A
      // failure here stops the workflow like any other stage failure; the
      // *content* of the verdict (still has issues vs. all clear) is just
      // the reviewer's normal text output - no separate success/failure
      // semantics are layered on top of that.
      let finalReviewResult = { summary: '', ok: true }
      yield* runReviewStage(
        'finalReview',
        spec.reviewer,
        buildFinalReviewPrompt(spec.task, latestReviewFindings, latestDiff),
        latestDiff,
        spec.workingDirectory,
        signal,
        (r) => (finalReviewResult = r)
      )
      if (signal?.aborted) {
        yield { kind: 'workflow_done', success: false, reason: 'Abgebrochen.' }
        return
      }
      if (!finalReviewResult.ok) {
        yield { kind: 'workflow_done', success: false, reason: 'Abschlussprüfung ist fehlgeschlagen.' }
        return
      }
    }

    yield { kind: 'workflow_done', success: true }
  }

  return { workflowId, events: run() }
}
