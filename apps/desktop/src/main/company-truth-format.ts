import { COMPANY_FACT_CATEGORY_LABELS } from './ipc-types'
import type { CompanyFact } from './ipc-types'

/**
 * Formats stored Company Truth facts and prepends them to a prompt, ahead
 * of the user's task and any attached evidence - facts are foundational
 * context the model should read first, not supporting evidence appended
 * after the ask (that's what AttachedArtifact/withAttachments is for).
 * Pulled into its own module (no electron/council-core imports) for the
 * same reason as attachments.ts: testable without any of that setup.
 */

export function formatCompanyFacts(facts: CompanyFact[]): string {
  return facts.map((f) => `[${COMPANY_FACT_CATEGORY_LABELS[f.category]}] ${f.text}`).join('\n')
}

export function withCompanyTruth(prompt: string, facts: CompanyFact[]): string {
  if (facts.length === 0) return prompt
  return `--- Unternehmenswissen (verbindlich - widersprich dem nicht) ---\n${formatCompanyFacts(facts)}\n\n${prompt}`
}
