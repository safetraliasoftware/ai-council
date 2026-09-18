import { expect, it } from 'vitest'
import { classifyTaskFailure, TaskControlError, validateTaskBudget } from '../../services/task-control'
import { DEFAULT_TASK_BUDGET } from '@ai-council/project-domain'

it.each([
  ['Not logged in · Please run /login', 'authentication'],
  ["You've hit your session limit", 'quota'],
  ['POLICY VIOLATION: source changed', 'policy'],
  ['SQLITE_FULL', 'storage'], ['Review fehlerhaft', 'implementation']
])('classifies %s', (message, kind) => expect(classifyTaskFailure(new Error(message))).toBe(kind))
it('preserves explicit process and budget failures and validates finite budgets', () => {
  expect(classifyTaskFailure(new TaskControlError('budget', 'stop'))).toBe('budget')
  expect(classifyTaskFailure(new TaskControlError('process', 'CLI disappeared'))).toBe('process')
  expect(() => validateTaskBudget(DEFAULT_TASK_BUDGET)).not.toThrow()
  expect(() => validateTaskBudget({ ...DEFAULT_TASK_BUDGET, maxCalls: NaN })).toThrow()
  expect(() => validateTaskBudget({ ...DEFAULT_TASK_BUDGET, maxActiveMs: Infinity })).toThrow()
})
