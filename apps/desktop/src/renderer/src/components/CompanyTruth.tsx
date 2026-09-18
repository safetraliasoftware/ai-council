import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CompanyFact, CompanyFactCategory } from '../../../main/ipc-types'
import { COMPANY_FACT_CATEGORY_LABELS } from '../../../main/ipc-types'

const CATEGORIES = Object.keys(COMPANY_FACT_CATEGORY_LABELS) as CompanyFactCategory[]
const CATEGORY_KEYS: Record<CompanyFactCategory, string> = {
  PRODUCT_FACT: 'companyTruth.categoryProductFact',
  TECH_FACT: 'companyTruth.categoryTechFact',
  MARKETING_RULE: 'companyTruth.categoryMarketingRule',
  LEGAL_RULE: 'companyTruth.categoryLegalRule',
  DECISION: 'companyTruth.categoryDecision'
}

/**
 * Company Truth: standing facts/rules about the actual business, kept
 * separate from any single conversation so Vergleichen/Team/Council can
 * optionally ground every run in the same facts instead of each provider
 * improvising its own (sometimes contradictory) assumptions. Content here
 * is entirely user-entered - this page is infrastructure, never seeded
 * with invented facts.
 */
export default function CompanyTruth(): React.JSX.Element {
  const { t } = useTranslation()
  const [facts, setFacts] = useState<CompanyFact[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState<CompanyFactCategory>('PRODUCT_FACT')
  const [text, setText] = useState('')

  const reload = async (): Promise<void> => {
    setFacts(await window.api.companyTruth.list())
    setLoading(false)
  }

  useEffect(() => {
    reload()
  }, [])

  const add = async (): Promise<void> => {
    if (!text.trim()) return
    await window.api.companyTruth.add(category, text.trim())
    setText('')
    await reload()
  }

  const remove = async (id: string): Promise<void> => {
    await window.api.companyTruth.delete(id)
    await reload()
  }

  return (
    <div>
      <div className="panel">
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          {t('companyTruth.intro')}
        </p>

        <div className="field">
          <label>{t('companyTruth.categoryLabel')}</label>
          <select value={category} onChange={(e) => setCategory(e.target.value as CompanyFactCategory)} style={{ width: 260 }}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(CATEGORY_KEYS[c])}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>{t('companyTruth.factLabel')}</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('companyTruth.factPlaceholder')}
          />
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="primary" onClick={add} disabled={!text.trim()}>
            {t('companyTruth.add')}
          </button>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        {loading && <span className="status-neutral">{t('companyTruth.loading')}</span>}
        {!loading && facts.length === 0 && (
          <span className="status-neutral">{t('companyTruth.noEntries')}</span>
        )}
        {!loading &&
          CATEGORIES.map((c) => {
            const inCategory = facts.filter((f) => f.category === c)
            if (inCategory.length === 0) return null
            return (
              <div key={c} style={{ marginBottom: 16 }}>
                <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--text-muted)' }}>
                  {t(CATEGORY_KEYS[c])}
                </h3>
                {inCategory.map((f) => (
                  <div key={f.id} className="row" style={{ alignItems: 'flex-start', marginBottom: 6 }}>
                    <span style={{ flex: 1, fontSize: 13 }}>{f.text}</span>
                    <button className="secondary" onClick={() => remove(f.id)}>
                      {t('companyTruth.delete')}
                    </button>
                  </div>
                ))}
              </div>
            )
          })}
      </div>
    </div>
  )
}
