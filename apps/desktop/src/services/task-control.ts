import type { TaskBudget, TaskFailureKind } from '@ai-council/project-domain'

export class TaskControlError extends Error {
  constructor(public kind: TaskFailureKind, message: string) { super(message) }
}

export function classifyTaskFailure(error: unknown): TaskFailureKind {
  if (error instanceof TaskControlError) return error.kind
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('POLICY VIOLATION:')) return 'policy'
  if (/not logged in|please run \/login|unauthenticated|authentication failed|invalid api key|unauthorized|\b401\b/i.test(message)) return 'authentication'
  if (/session limit|usage limit|rate.?limit|quota|insufficient_quota|\b429\b/i.test(message)) return 'quota'
  if (/^Abgebrochen\./i.test(message)) return 'cancelled'
  if (/SQLITE_|ENOSPC|EACCES|EROFS|disk full/i.test(message)) return 'storage'
  return 'implementation'
}

export function validateTaskBudget(budget: TaskBudget): void {
  if (!budget || !Number.isInteger(budget.maxCalls) || budget.maxCalls < 1 || budget.maxCalls > 100 ||
    !Number.isInteger(budget.maxCorrections) || budget.maxCorrections < 0 || budget.maxCorrections > 20 ||
    !Number.isInteger(budget.maxActiveMs) || budget.maxActiveMs < 1000 || budget.maxActiveMs > 4 * 60 * 60_000) {
    throw new Error('Ungültiges Taskbudget: 1–100 Aufrufe, 0–20 Korrekturen und 1 Sekunde bis 4 Stunden aktive Laufzeit.')
  }
}
