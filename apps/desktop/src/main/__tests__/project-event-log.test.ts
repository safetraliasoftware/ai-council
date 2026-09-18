import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProjectSpecification } from '@ai-council/project-domain'

const { mockUserDataDir } = vi.hoisted(() => ({ mockUserDataDir: { current: '' } }))

vi.mock('electron', () => ({
  app: { getPath: () => mockUserDataDir.current }
}))

const { appendEvent, replayProject, replayChangeRequests } = await import('../project-event-log')

function fixtureSpec(overrides: Partial<ProjectSpecification> = {}): ProjectSpecification {
  return {
    id: 'proj-1',
    version: 1,
    goal: 'Dienstplan-App bauen',
    requirements: [
      { id: 'REQ-001', category: 'feature', statement: 'Schichten planen', acceptanceCriteria: ['Nutzer kann eine Schicht anlegen'] }
    ],
    nonGoals: [],
    architectureNotes: '',
    risks: [],
    openQuestions: [],
    chairId: 'anthropic',
    rawSynthesisText: '{}',
    status: 'council_generated',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

describe('project-event-log', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-council-project-log-'))
    mockUserDataDir.current = dir
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends events in order and replays a single version', async () => {
    await appendEvent('proj-1', {
      projectId: 'proj-1',
      type: 'SpecificationCouncilGenerated',
      timestamp: 1000,
      payload: fixtureSpec()
    })

    const versions = replayProject('proj-1')
    expect(versions).toHaveLength(1)
    expect(versions[0].version).toBe(1)
    expect(versions[0].status).toBe('council_generated')
  })

  it('folds a human-approval event onto the version it references', async () => {
    await appendEvent('proj-1', {
      projectId: 'proj-1',
      type: 'SpecificationCouncilGenerated',
      timestamp: 1000,
      payload: fixtureSpec()
    })
    await appendEvent('proj-1', {
      projectId: 'proj-1',
      type: 'SpecificationHumanApproved',
      timestamp: 2000,
      payload: { version: 1 }
    })

    const versions = replayProject('proj-1')
    expect(versions[0].status).toBe('human_approved')
    expect(versions[0].updatedAt).toBe(2000)
  })

  it('folds multiple versions correctly, marking the superseded one', async () => {
    await appendEvent('proj-1', {
      projectId: 'proj-1',
      type: 'SpecificationCouncilGenerated',
      timestamp: 1000,
      payload: fixtureSpec({ version: 1 })
    })
    await appendEvent('proj-1', {
      projectId: 'proj-1',
      type: 'SpecificationSuperseded',
      timestamp: 1500,
      payload: { version: 1 }
    })
    await appendEvent('proj-1', {
      projectId: 'proj-1',
      type: 'SpecificationCouncilGenerated',
      timestamp: 2000,
      payload: fixtureSpec({ version: 2, supersedesVersion: 1 })
    })

    const versions = replayProject('proj-1')
    expect(versions.map((v) => v.version)).toEqual([1, 2])
    expect(versions[0].status).toBe('superseded')
    expect(versions[1].status).toBe('council_generated')
  })

  it('assigns monotonically increasing sequence numbers', async () => {
    const e1 = await appendEvent('proj-1', {
      projectId: 'proj-1',
      type: 'SpecificationDrafted',
      timestamp: 1000,
      payload: {}
    })
    const e2 = await appendEvent('proj-1', {
      projectId: 'proj-1',
      type: 'SpecificationCouncilGenerated',
      timestamp: 1100,
      payload: fixtureSpec()
    })
    expect(e2.sequence).toBe(e1.sequence + 1)
  })

  it('tolerates a truncated last line (a crash mid-write)', async () => {
    await appendEvent('proj-1', {
      projectId: 'proj-1',
      type: 'SpecificationCouncilGenerated',
      timestamp: 1000,
      payload: fixtureSpec()
    })

    const logPath = join(dir, 'projects', 'proj-1', 'events.jsonl')
    appendFileSync(logPath, '{"eventId":"broken-partial-wri')

    expect(() => replayProject('proj-1')).not.toThrow()
    expect(replayProject('proj-1')).toHaveLength(1)
  })

  it('throws on a corrupted line that is NOT the last one, instead of silently dropping it', () => {
    const logDir = join(dir, 'projects', 'proj-1')
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, 'events.jsonl')
    appendFileSync(logPath, 'this is not json at all\n')
    appendFileSync(
      logPath,
      JSON.stringify({
        eventId: 'e2',
        projectId: 'proj-1',
        sequence: 2,
        schemaVersion: 1,
        type: 'SpecificationCouncilGenerated',
        timestamp: 1000,
        payload: fixtureSpec()
      }) + '\n'
    )

    expect(() => replayProject('proj-1')).toThrow(/beschädigt/)
  })

  it('returns an empty list for a project with no log file yet', () => {
    expect(replayProject('never-seen-project')).toEqual([])
  })

  it('does not parse unchanged history again for repeated task-card polls', async () => {
    await appendEvent('cached', {
      projectId: 'cached', type: 'SpecificationCouncilGenerated', timestamp: 1000,
      payload: fixtureSpec()
    })
    replayProject('cached')
    replayChangeRequests('cached')
    const parse = vi.spyOn(JSON, 'parse')
    try {
      for (let i = 0; i < 20; i++) {
        expect(replayProject('cached')).toHaveLength(1)
        expect(replayChangeRequests('cached')).toEqual([])
      }
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
    const specs = replayProject('cached')
    specs[0].status = 'rejected'
    expect(replayProject('cached')[0].status).toBe('council_generated')
    await appendEvent('cached', {
      projectId: 'cached', type: 'SpecificationHumanApproved', timestamp: 2000,
      payload: { version: 1 }
    })
    expect(replayProject('cached')[0].status).toBe('human_approved')
    appendFileSync(join(dir, 'projects', 'cached', 'events.jsonl'), JSON.stringify({
      projectId: 'cached', type: 'SpecificationRejected', timestamp: 3000,
      sequence: 3, payload: { version: 1 }
    }) + '\n')
    expect(replayProject('cached')[0].status).toBe('rejected')
  })

  it('repairs a truncated tail before subsequent writes, preserving Unicode records', async () => {
    await appendEvent('repair', {
      projectId: 'repair', type: 'SpecificationCouncilGenerated', timestamp: 1000,
      payload: fixtureSpec({ goal: 'Grüße aus Köln' })
    })
    appendFileSync(join(dir, 'projects', 'repair', 'events.jsonl'), '{"partial":')
    const approved = await appendEvent('repair', {
      projectId: 'repair', type: 'SpecificationHumanApproved', timestamp: 2000,
      payload: { version: 1 }
    })
    expect(approved.sequence).toBe(2)
    expect(replayProject('repair')[0]).toMatchObject({ goal: 'Grüße aus Köln', status: 'human_approved' })
    await appendEvent('repair', {
      projectId: 'repair', type: 'SpecificationDrafted', timestamp: 3000, payload: {}
    })
    expect(() => replayProject('repair')).not.toThrow()
  })

  it('allows retrying after a filesystem write failure', async () => {
    const logPath = join(dir, 'projects', 'retry', 'events.jsonl')
    mkdirSync(logPath, { recursive: true })
    const event = {
      projectId: 'retry', type: 'SpecificationCouncilGenerated' as const,
      timestamp: 1000, payload: fixtureSpec()
    }
    await expect(appendEvent('retry', event)).rejects.toThrow()
    rmSync(logPath, { recursive: true })
    await expect(appendEvent('retry', event)).resolves.toMatchObject({ sequence: 1 })
    expect(replayProject('retry')).toHaveLength(1)
  })

  it('serializes concurrent writes with consecutive sequence numbers', async () => {
    const events = await Promise.all(Array.from({ length: 10 }, (_, timestamp) => appendEvent('parallel', {
      projectId: 'parallel', type: 'SpecificationDrafted', timestamp, payload: {}
    })))
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  describe('replayChangeRequests', () => {
    it('refreshes cached requests after writes and isolates returned objects', async () => {
      await appendEvent('cr-cache', {
        projectId: 'cr-cache', type: 'ChangeRequestOpened', timestamp: 1000,
        payload: { id: 'cr-1', projectId: 'cr-cache', reason: 'x', affectedRequirementIds: [], affectedTaskIds: ['T1'],
          proposedChanges: '', severity: 'minor', status: 'pending', createdAt: 1000 }
      })
      replayChangeRequests('cr-cache')[0].affectedTaskIds.push('T2')
      expect(replayChangeRequests('cr-cache')[0].affectedTaskIds).toEqual(['T1'])
      await appendEvent('cr-cache', {
        projectId: 'cr-cache', type: 'ChangeRequestRejected', timestamp: 2000, payload: { id: 'cr-1' }
      })
      expect(replayChangeRequests('cr-cache')[0].status).toBe('rejected')
      rmSync(join(dir, 'projects', 'cr-cache', 'events.jsonl'))
      expect(replayChangeRequests('cr-cache')).toEqual([])
    })

    it('folds the full lifecycle: opened -> council-evaluated -> human-approved -> linked to spec -> applied', async () => {
      await appendEvent('cr-proj', {
        projectId: 'cr-proj', type: 'ChangeRequestOpened', timestamp: 1000,
        payload: { id: 'cr-1', projectId: 'cr-proj', reason: 'Architektur-Problem', affectedRequirementIds: ['REQ-001'],
          affectedTaskIds: ['TASK-001'], proposedChanges: '', severity: 'architecture', status: 'pending', createdAt: 1000 }
      })
      await appendEvent('cr-proj', {
        projectId: 'cr-proj', type: 'ChangeRequestProposalUpdated', timestamp: 1100,
        payload: { id: 'cr-1', proposedChanges: 'Neuer Ansatz', severity: 'minor' }
      })
      await appendEvent('cr-proj', {
        projectId: 'cr-proj', type: 'ChangeRequestCouncilEvaluated', timestamp: 1200,
        payload: { id: 'cr-1', councilRationale: 'Sinnvoll.' }
      })
      await appendEvent('cr-proj', {
        projectId: 'cr-proj', type: 'ChangeRequestHumanApproved', timestamp: 1300, payload: { id: 'cr-1' }
      })
      await appendEvent('cr-proj', {
        projectId: 'cr-proj', type: 'ChangeRequestLinkedToSpec', timestamp: 1400, payload: { id: 'cr-1', specVersion: 2 }
      })
      await appendEvent('cr-proj', {
        projectId: 'cr-proj', type: 'ChangeRequestApplied', timestamp: 1500, payload: { id: 'cr-1' }
      })

      const [cr] = replayChangeRequests('cr-proj')
      expect(cr).toMatchObject({
        id: 'cr-1', proposedChanges: 'Neuer Ansatz', severity: 'minor', councilRationale: 'Sinnvoll.',
        status: 'human_approved', resultingSpecVersion: 2, appliedAt: 1500
      })
    })

    it('folds a rejected ChangeRequest to status "rejected"', async () => {
      await appendEvent('cr-proj', {
        projectId: 'cr-proj', type: 'ChangeRequestOpened', timestamp: 1000,
        payload: { id: 'cr-1', projectId: 'cr-proj', reason: 'x', affectedRequirementIds: [], affectedTaskIds: ['T1'],
          proposedChanges: '', severity: 'minor', status: 'pending', createdAt: 1000 }
      })
      await appendEvent('cr-proj', {
        projectId: 'cr-proj', type: 'ChangeRequestRejected', timestamp: 1100, payload: { id: 'cr-1' }
      })
      expect(replayChangeRequests('cr-proj')[0].status).toBe('rejected')
    })

    it('ignores lifecycle events for an unknown ChangeRequest id instead of throwing', async () => {
      await appendEvent('cr-proj', {
        projectId: 'cr-proj', type: 'ChangeRequestHumanApproved', timestamp: 1000, payload: { id: 'never-opened' }
      })
      expect(replayChangeRequests('cr-proj')).toEqual([])
    })

    it('returns an empty list for a project with no change requests', () => {
      expect(replayChangeRequests('never-seen-project')).toEqual([])
    })
  })
})
