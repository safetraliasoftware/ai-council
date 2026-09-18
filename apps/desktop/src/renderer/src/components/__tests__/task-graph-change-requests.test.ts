import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectExecution, TaskAttempt, TaskGraphSnapshot } from '@ai-council/project-domain'
const snapshot = vi.hoisted(() => ({ execution: undefined as ProjectExecution | undefined, used: false }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof React>()
  return { ...actual, useState: (initial: unknown) => {
    if (initial === undefined && !snapshot.used) {
      snapshot.used = true
      return actual.useState(snapshot.execution)
    }
    return actual.useState(initial)
  } }
})
vi.mock('../ChangeRequests', () => ({ default: ({ taskId }: { taskId: string }) => `change-requests-for-${taskId}` }))
import TaskGraphExecution from '../TaskGraphExecution'
afterEach(() => vi.unstubAllGlobals())
it('offers correction continuation instead of increasing an exhausted attempt limit', () => {
  vi.stubGlobal('React', React)
  snapshot.used = false
  const attempt: TaskAttempt = { id: 'a', taskId: 't', specVersion: 1, status: 'failed', startedAt: 0,
    implementerId: 'one', reviewerId: 'two', verification: [], events: [], reviews: [{ verdict: 'fail', findings: [] }],
    error: 'Prüfungen oder Reviews weiterhin fehlgeschlagen.', taskStartCommit: 'base',
    worktree: { path: 'work', branch: 'task', sourceRepo: 'repo' } }
  snapshot.execution = { projectId: 'p', runId: 'r', specVersion: 1, phase: 'halted', commands: [], maxAttempts: 1, attempts: [attempt], updatedAt: 0 }
  const graph: TaskGraphSnapshot = { projectId: 'p', specVersion: 1, status: 'human_approved', chairId: 'anthropic', rawSynthesisText: '', createdAt: 0, updatedAt: 0,
    tasks: [{ id: 't', specVersion: 1, status: 'failed', title: 'Task', description: '', requirementIds: [], dependencies: [], scope: { allowedPaths: [] } }] }
  const html = renderToStaticMarkup(React.createElement(TaskGraphExecution, { projectId: 'p', taskGraph: graph, onChanged: () => {}, onRequestSpecRevision: () => {} }))
  expect(html).toContain('Korrektur fortsetzen')
  expect(html).not.toContain('Versuchslimit auf')
})
it.each(['escalated', 'discarded', 'failed', 'accepted'] as const)('keeps the change-request view available for a %s attempt', status => {
  vi.stubGlobal('React', React) // Vitest's default JSX transform; the app uses the React Vite plugin.
  snapshot.used = false
  const attempt: TaskAttempt = { id: 'a', taskId: 't', specVersion: 1, status, startedAt: 0, implementerId: 'one', reviewerId: 'two', verification: [], reviews: [], events: [] }
  snapshot.execution = { projectId: 'p', runId: 'r', specVersion: 1, phase: 'halted', commands: [], maxAttempts: 3, attempts: [attempt], updatedAt: 0 }
  const graph: TaskGraphSnapshot = { projectId: 'p', specVersion: 1, status: 'human_approved', chairId: 'anthropic', rawSynthesisText: '', createdAt: 0, updatedAt: 0,
    tasks: [{ id: 't', specVersion: 1, status: 'failed', title: 'Task', description: '', requirementIds: [], dependencies: [], scope: { allowedPaths: [] } }] }
  const html = renderToStaticMarkup(React.createElement(TaskGraphExecution, { projectId: 'p', taskGraph: graph, onChanged: () => {}, onRequestSpecRevision: () => {} }))
  expect(html).toContain('change-requests-for-t')
})
