import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { appendFile, readFile, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangeRequest, ProjectEvent, ProjectSpecification } from '@ai-council/project-domain'
import { assertSafeId } from './json-file-store'

/**
 * Append-only JSONL event log per project, replayed into the current set of
 * ProjectSpecification versions. Chosen over the read-modify-write-whole-
 * file pattern used elsewhere (run-history-store.ts etc.) because a
 * project-scoped run can outlive a single click-to-confirm workflow by
 * hours, and needs to survive an app restart without losing track of state
 * (see the plan's "Persistenz-Lücke" note for the analogous worktree case).
 */

function projectDir(projectId: string): string {
  assertSafeId(projectId, 'Projekt-ID')
  return join(app.getPath('userData'), 'projects', projectId)
}

function eventsPath(projectId: string): string {
  return join(projectDir(projectId), 'events.jsonl')
}

function readLines(projectId: string): string[] {
  try {
    const raw = readFileSync(eventsPath(projectId), 'utf-8')
    return raw.split('\n').filter((line) => line.trim().length > 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * A truncated last line (an app crash mid-write) is tolerated and dropped.
 * A broken line ANYWHERE ELSE would be silent, unrecoverable data loss if
 * ignored the same way - so that case throws instead of being swallowed.
 */
function parseLines(lines: string[]): ProjectEvent[] {
  const events: ProjectEvent[] = []
  lines.forEach((line, index) => {
    try {
      events.push(JSON.parse(line) as ProjectEvent)
    } catch (err) {
      const isLastLine = index === lines.length - 1
      if (isLastLine) return
      throw new Error(
        `Event-Log ist beschädigt: Zeile ${index + 1} von ${lines.length} ist kein gültiges JSON (nicht die letzte Zeile, also keine bloße Absturz-Spur). Ursprünglicher Fehler: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })
  return events
}

const writeQueues = new Map<string, Promise<unknown>>()

export async function flushProjectEvents(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const pending = [...writeQueues.values()]
    if (pending.length === 0) return
    await Promise.all(pending)
  }
}

// Cache only the small UI projections, never legacy execution snapshots.
// Each task card polls this log; parsing the entire history per card blocks
// Electron's main thread. File metadata also detects edits outside this process.
const projections = new Map<string, {
  signature: string
  specs?: ProjectSpecification[]
  requests?: ChangeRequest[]
}>()

function projectionCache(projectId: string) {
  const path = eventsPath(projectId)
  let signature: string
  try {
    const stat = statSync(path, { bigint: true })
    signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch (err) {
    projections.delete(path)
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  const cached = projections.get(path)
  if (cached?.signature === signature) return cached
  const entry: NonNullable<ReturnType<typeof projections.get>> = { signature }
  // Bound memory when many projects are visited during a session.
  if (projections.size >= 64) projections.delete(projections.keys().next().value!)
  projections.set(path, entry)
  return entry
}

/**
 * Vergibt eventId/sequence/schemaVersion und hängt die Zeile über eine
 * sequenzielle async Write-Queue an - kein appendFileSync, damit ein langer
 * Agent-Lauf den Electron-Main-Thread nicht regelmäßig blockiert, und keine
 * zwei Schreibvorgänge für dasselbe Projekt sich je überlappen.
 */
export function appendEvent(
  projectId: string,
  event: Omit<ProjectEvent, 'eventId' | 'sequence' | 'schemaVersion'>
): Promise<ProjectEvent> {
  const path = eventsPath(projectId)
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    const dir = projectDir(projectId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    let raw = ''
    try {
      raw = await readFile(path, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const lines = raw.split('\n').filter((line) => line.trim().length > 0)
    const events = parseLines(lines)
    // Repair a partial final record before appending, otherwise the new
    // event becomes part of the broken line and is lost during replay.
    if (events.length < lines.length) {
      raw = raw.slice(0, raw.lastIndexOf(lines[lines.length - 1]))
      await truncate(path, Buffer.byteLength(raw, 'utf-8'))
    }
    const fullEvent: ProjectEvent = {
      ...event,
      eventId: randomUUID(),
      sequence: events.reduce((max, e) => Math.max(max, e.sequence), 0) + 1,
      schemaVersion: 1
    }
    const separator = raw.length > 0 && !raw.endsWith('\n') ? '\n' : ''
    await appendFile(path, separator + JSON.stringify(fullEvent) + '\n', 'utf-8')
    projections.delete(path)
    return fullEvent
  })
  writeQueues.set(path, next)
  const cleanup = (): void => {
    if (writeQueues.get(path) === next) writeQueues.delete(path)
  }
  void next.then(cleanup, cleanup)
  return next
}

/** Folds a project's full event log into every ProjectSpecification version it has ever had. */
export function replayProject(projectId: string): ProjectSpecification[] {
  const cached = projectionCache(projectId)
  if (cached?.specs) return structuredClone(cached.specs)
  const events = parseLines(readLines(projectId)).sort((a, b) => a.sequence - b.sequence)
  const versions = new Map<number, ProjectSpecification>()

  for (const event of events) {
    switch (event.type) {
      case 'SpecificationCouncilGenerated': {
        const spec = event.payload as ProjectSpecification
        versions.set(spec.version, spec)
        break
      }
      case 'SpecificationHumanApproved':
      case 'SpecificationRejected':
      case 'SpecificationSuperseded': {
        const { version } = event.payload as { version: number }
        const spec = versions.get(version)
        if (spec) {
          spec.status =
            event.type === 'SpecificationHumanApproved'
              ? 'human_approved'
              : event.type === 'SpecificationRejected'
                ? 'rejected'
                : 'superseded'
          spec.updatedAt = event.timestamp
        }
        break
      }
      case 'SpecificationDrafted':
        break // informational only, never produces a version on its own
    }
  }

  const result = [...versions.values()].sort((a, b) => a.version - b.version)
  if (cached) cached.specs = structuredClone(result)
  return result
}

/**
 * Folds a project's full event log into its ChangeRequests - same
 * fold-over-events pattern as replayProject, sharing the same events.jsonl
 * (no separate store/write-queue needed, this log already mixes
 * specification and execution events per project).
 */
export function replayChangeRequests(projectId: string): ChangeRequest[] {
  const cached = projectionCache(projectId)
  if (cached?.requests) return structuredClone(cached.requests)
  const events = parseLines(readLines(projectId)).sort((a, b) => a.sequence - b.sequence)
  const requests = new Map<string, ChangeRequest>()

  for (const event of events) {
    switch (event.type) {
      case 'ChangeRequestOpened': {
        const cr = event.payload as ChangeRequest
        requests.set(cr.id, cr)
        break
      }
      case 'ChangeRequestProposalUpdated': {
        const { id, proposedChanges, severity } = event.payload as { id: string; proposedChanges: string; severity: ChangeRequest['severity'] }
        const cr = requests.get(id)
        if (cr) {
          cr.proposedChanges = proposedChanges
          cr.severity = severity
        }
        break
      }
      case 'ChangeRequestCouncilEvaluated': {
        const { id, councilRationale, councilRecommendation } = event.payload as {
          id: string; councilRationale: string; councilRecommendation?: 'proceed' | 'reject'
        }
        const cr = requests.get(id)
        if (cr) {
          cr.councilRationale = councilRationale
          cr.councilRecommendation = councilRecommendation
          cr.status = 'council_approved'
        }
        break
      }
      case 'ChangeRequestHumanApproved':
      case 'ChangeRequestRejected': {
        const { id } = event.payload as { id: string }
        const cr = requests.get(id)
        if (cr) cr.status = event.type === 'ChangeRequestHumanApproved' ? 'human_approved' : 'rejected'
        break
      }
      case 'ChangeRequestLinkedToSpec': {
        const { id, specVersion } = event.payload as { id: string; specVersion: number }
        const cr = requests.get(id)
        if (cr) cr.resultingSpecVersion = specVersion
        break
      }
      case 'ChangeRequestApplied': {
        const { id } = event.payload as { id: string }
        const cr = requests.get(id)
        if (cr) cr.appliedAt = event.timestamp
        break
      }
    }
  }

  const result = [...requests.values()].sort((a, b) => a.createdAt - b.createdAt)
  if (cached) cached.requests = structuredClone(result)
  return result
}

export function readProjectEvents(projectId: string): ProjectEvent[] {
  return parseLines(readLines(projectId)).sort((a, b) => a.sequence - b.sequence)
}

export function listProjectIds(): string[] {
  const root = join(app.getPath('userData'), 'projects')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}
