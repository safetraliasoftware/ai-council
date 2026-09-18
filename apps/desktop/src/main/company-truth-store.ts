import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomic } from './json-file-store'
import type { CompanyFact, CompanyFactCategory } from './ipc-types'

/** Flat JSON-file store for Company Truth facts, same pattern as run-history-store.ts / projects-store.ts. */

function storePath(): string {
  return join(app.getPath('userData'), 'company-truth.json')
}

function readAll(): CompanyFact[] {
  const parsed = readJsonFileSafe<unknown>(storePath(), [])
  return Array.isArray(parsed) ? (parsed as CompanyFact[]) : []
}

function writeAll(facts: CompanyFact[]): void {
  writeJsonFileAtomic(storePath(), facts)
}

export function listCompanyFacts(): CompanyFact[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt)
}

export function addCompanyFact(category: CompanyFactCategory, text: string): CompanyFact {
  const fact: CompanyFact = { id: randomUUID(), category, text, createdAt: Date.now() }
  const facts = readAll()
  facts.push(fact)
  writeAll(facts)
  return fact
}

export function deleteCompanyFact(id: string): void {
  writeAll(readAll().filter((f) => f.id !== id))
}
