import { describe, expect, it } from 'vitest'
import { formatCompanyFacts, withCompanyTruth } from '../company-truth-format'
import type { CompanyFact } from '../ipc-types'

function fact(category: CompanyFact['category'], text: string): CompanyFact {
  return { id: 'x', category, text, createdAt: 0 }
}

describe('formatCompanyFacts', () => {
  it('labels each fact with its category', () => {
    const result = formatCompanyFacts([fact('PRODUCT_FACT', 'Keine native iOS-App.')])
    expect(result).toBe('[Produktfakt] Keine native iOS-App.')
  })

  it('joins multiple facts on separate lines, in the given order', () => {
    const result = formatCompanyFacts([
      fact('PRODUCT_FACT', 'Fakt A'),
      fact('LEGAL_RULE', 'Regel B')
    ])
    expect(result).toBe('[Produktfakt] Fakt A\n[Rechtliche Regel] Regel B')
  })
})

describe('withCompanyTruth', () => {
  it('returns the prompt unchanged when there are no facts', () => {
    expect(withCompanyTruth('Was denkst du?', [])).toBe('Was denkst du?')
  })

  it('prepends facts before the prompt, not after', () => {
    const result = withCompanyTruth('Was denkst du?', [fact('MARKETING_RULE', 'Keine Bestehensgarantie.')])

    const factIndex = result.indexOf('Keine Bestehensgarantie.')
    const promptIndex = result.indexOf('Was denkst du?')
    expect(factIndex).toBeGreaterThan(-1)
    expect(promptIndex).toBeGreaterThan(factIndex)
  })
})
