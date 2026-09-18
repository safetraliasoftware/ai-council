import { describe, expect, it } from 'vitest'
import { TaskGraph } from '@ai-council/task-graph'
import type { ExecutionTask } from '@ai-council/task-graph'
import { isTaskGraphParseError, parseTaskGraphJson } from '../task-graph-format'

/**
 * Mirrors exactly what task-graph-ipc.ts does with a Council response: parse
 * the JSON, stamp specVersion/status server-side, then validate through the
 * same TaskGraph.addTasks() the Phase 0 engine already tests exhaustively.
 * This proves the composition rejects an invalid Council-generated graph
 * instead of silently persisting one - not re-testing addTasks() itself.
 */
function toExecutionTasks(rawText: string, specVersion: number): ExecutionTask[] {
  const parsed = parseTaskGraphJson(rawText)
  if (isTaskGraphParseError(parsed)) throw new Error(parsed.error)
  return parsed.map((t) => ({ ...t, specVersion, status: 'pending' as const }))
}

describe('Council-generated task graph validation', () => {
  it('accepts a valid, acyclic graph', () => {
    const raw =
      '```json\n' +
      JSON.stringify([
        { id: 'TASK-001', requirementIds: [], title: 'A', description: '', dependencies: [], scope: {} },
        {
          id: 'TASK-002',
          requirementIds: [],
          title: 'B',
          description: '',
          dependencies: [{ taskId: 'TASK-001', impact: 'hard' }],
          scope: {}
        }
      ]) +
      '\n```'

    const tasks = toExecutionTasks(raw, 1)
    expect(() => new TaskGraph().addTasks(tasks)).not.toThrow()
  })

  it('rejects a Council-generated graph containing a cycle', () => {
    const raw =
      '```json\n' +
      JSON.stringify([
        {
          id: 'TASK-001',
          requirementIds: [],
          title: 'A',
          description: '',
          dependencies: [{ taskId: 'TASK-002', impact: 'hard' }],
          scope: {}
        },
        {
          id: 'TASK-002',
          requirementIds: [],
          title: 'B',
          description: '',
          dependencies: [{ taskId: 'TASK-001', impact: 'hard' }],
          scope: {}
        }
      ]) +
      '\n```'

    const tasks = toExecutionTasks(raw, 1)
    expect(() => new TaskGraph().addTasks(tasks)).toThrow(/cycle/)
  })

  it('rejects a Council-generated graph referencing an unknown task id', () => {
    const raw =
      '```json\n' +
      JSON.stringify([
        {
          id: 'TASK-001',
          requirementIds: [],
          title: 'A',
          description: '',
          dependencies: [{ taskId: 'TASK-GHOST', impact: 'hard' }],
          scope: {}
        }
      ]) +
      '\n```'

    const tasks = toExecutionTasks(raw, 1)
    expect(() => new TaskGraph().addTasks(tasks)).toThrow(/unknown task/)
  })
})
