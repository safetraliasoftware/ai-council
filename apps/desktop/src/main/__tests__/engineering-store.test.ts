import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectExecution, TaskGraphSnapshot } from '@ai-council/project-domain'
const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }))
import { saveExecution, loadExecution } from '../engineering-store'
import { readTaskGraph, writeTaskGraph } from '../task-graph-store'
import { appendEvent } from '../project-event-log'
beforeEach(() => { state.dir = mkdtempSync(join(tmpdir(), 'council-execution-journal-')) })
afterEach(() => { rmSync(state.dir, { recursive: true, force: true }) })
it.each(['running', 'awaiting_permission', 'awaiting_install'] as const)('replays %s and subsequent streamed evidence while preserving a later human rejection', async (status) => {
  const graph: TaskGraphSnapshot = { projectId: 'p', specVersion: 1, status: 'human_approved', chairId: 'anthropic', rawSynthesisText: '', createdAt: 0, updatedAt: 0,
    tasks: [{ id: 't', title: 'task', description: '', specVersion: 1, status: 'pending', requirementIds: [], dependencies: [], scope: { allowedPaths: [] } }] }
  const execution: ProjectExecution = { projectId: 'p', runId: 'r', specVersion: 1, phase: 'execution', commands: [], maxAttempts: 3, updatedAt: 0,
    attempts: [{ id: 'a', taskId: 't', specVersion: 1, startedAt: 0, status, implementerId: 'one', reviewerId: 'two', verification: [], reviews: [], events: [] }] }
  await saveExecution(execution, graph, 'TaskStarted')
  await appendEvent('p', { projectId: 'p', type: 'ExecutionAgentEvent', timestamp: 1, payload: { attemptId: 'a', event: { message: 'durable evidence' } } })
  writeTaskGraph('p', { ...graph, status: 'rejected' })
  const restored = loadExecution('p')!
  expect(restored.attempts[0].events).toEqual([{ message: 'durable evidence' }])
  expect(readTaskGraph('p')?.status).toBe('rejected')
  expect(readTaskGraph('p')?.tasks[0].status).toBe('in_progress')
})
