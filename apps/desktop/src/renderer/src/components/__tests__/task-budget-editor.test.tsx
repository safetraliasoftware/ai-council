import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import TaskBudgetEditor, { extendedTimeBudget } from '../TaskBudgetEditor'
import { DEFAULT_TASK_BUDGET } from '@ai-council/project-domain'

afterEach(() => vi.unstubAllGlobals())
it('offers the 30-to-60-minute increase directly in an open paused-task menu', () => {
  vi.stubGlobal('React', React)
  const html = renderToStaticMarkup(<TaskBudgetEditor taskId="TASK-004" budget={DEFAULT_TASK_BUDGET} usedMs={1800337} paused disabled={false} onSave={async () => {}} />)
  expect(html).toContain('<details open=""')
  expect(html).toContain('Budget für TASK-004 ändern')
  expect(html).toContain('Zeitlimit auf 60 Minuten erhöhen')
  expect(extendedTimeBudget(DEFAULT_TASK_BUDGET, 1800337)).toEqual({ ...DEFAULT_TASK_BUDGET, maxActiveMs: 3600000 })
})
it('never suggests a limit below spent time or above the supported maximum', () => {
  expect(extendedTimeBudget(DEFAULT_TASK_BUDGET, 90 * 60000).maxActiveMs).toBeGreaterThan(90 * 60000)
  expect(extendedTimeBudget({ ...DEFAULT_TASK_BUDGET, maxActiveMs: 230 * 60000 }, 230 * 60000).maxActiveMs).toBe(240 * 60000)
})
