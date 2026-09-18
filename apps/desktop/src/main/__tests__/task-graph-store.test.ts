import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TaskGraphSnapshot } from '@ai-council/project-domain'

const { mockUserDataDir } = vi.hoisted(() => ({ mockUserDataDir: { current: '' } }))

vi.mock('electron', () => ({
  app: { getPath: () => mockUserDataDir.current }
}))

const { readTaskGraph, writeTaskGraph } = await import('../task-graph-store')

function fixtureSnapshot(overrides: Partial<TaskGraphSnapshot> = {}): TaskGraphSnapshot {
  return {
    projectId: 'proj-1',
    specVersion: 1,
    tasks: [
      {
        id: 'TASK-001',
        specVersion: 1,
        requirementIds: ['REQ-001'],
        title: 'Datenmodell anlegen',
        description: '',
        dependencies: [],
        scope: { allowedPaths: [] },
        status: 'pending'
      }
    ],
    status: 'council_generated',
    chairId: 'anthropic',
    rawSynthesisText: '[]',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

describe('task-graph-store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-task-graph-store-'))
    mockUserDataDir.current = dir
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns undefined for a project with no task graph yet', () => {
    expect(readTaskGraph('never-seen-project')).toBeUndefined()
  })

  it('round-trips a snapshot through write and read', () => {
    writeTaskGraph('proj-1', fixtureSnapshot())
    const read = readTaskGraph('proj-1')
    expect(read?.status).toBe('council_generated')
    expect(read?.tasks).toHaveLength(1)
    expect(read?.tasks[0].id).toBe('TASK-001')
  })

  it('overwrites the previous snapshot on a second write (no version history)', () => {
    writeTaskGraph('proj-1', fixtureSnapshot({ status: 'council_generated' }))
    writeTaskGraph('proj-1', fixtureSnapshot({ status: 'human_approved' }))
    expect(readTaskGraph('proj-1')?.status).toBe('human_approved')
  })

  it('REGRESSION (Absturz bei alten Ersatz-Task-Daten): normalizes a legacy string replacedByTaskId into a list instead of crashing the UI\'s .join()', () => {
    // replacedByTaskId used to be a single string before it became a list
    // (to support splitting one invalidated task into several
    // replacements) - a graph saved by an older version of this app still
    // has the old shape on disk. Written directly (not via writeTaskGraph,
    // whose TS type now only allows the new shape) to simulate that.
    const legacy = fixtureSnapshot({
      tasks: [
        { ...fixtureSnapshot().tasks[0], id: 'OLD', status: 'invalidated', replacedByTaskId: 'NEW-1' as unknown as string[] }
      ]
    })
    const projectDir = join(dir, 'projects', 'proj-1')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'task-graph.json'), JSON.stringify(legacy))

    const read = readTaskGraph('proj-1')
    expect(read?.tasks[0].replacedByTaskId).toEqual(['NEW-1'])
  })
})
