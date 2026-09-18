import { expect, it } from 'vitest'
import { isTaskGraphParseError, parseTaskGraphJson } from '../task-graph-format'
import { parseReplacementTasks } from '../change-request-format'

it.each([
  { requirementIds: [123] }, { requirementIds: [{}] }, { requirementIds: 'REQ-1' },
  { scope: { allowedPaths: [null] } }, { scope: { allowedPaths: [42] } }, { scope: { allowedPaths: 'src/**' } }
])('rejects unsafe task fields in both graph and replacement responses: %j', fields => {
  const text = JSON.stringify([{ id: 'new-task', title: 'Task', replacesTaskId: 'old-task', dependencies: [], ...fields }])
  expect(isTaskGraphParseError(parseTaskGraphJson(text))).toBe(true)
  expect(() => parseReplacementTasks(text, ['old-task'])).toThrow(/Liste von Zeichenketten/)
})
it.each(['suspectedFiles', 'readOnlyContext'])('rejects invalid context paths in %s', field => {
  expect(isTaskGraphParseError(parseTaskGraphJson(JSON.stringify([{ id: 't', title: 'Task', scope: { [field]: [{}] } }])))).toBe(true)
})
