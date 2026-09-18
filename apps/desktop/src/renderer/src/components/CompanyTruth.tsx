import { useEffect, useState } from 'react'
import type { CompanyFact, CompanyFactCategory } from '../../../main/ipc-types'
import { COMPANY_FACT_CATEGORY_LABELS } from '../../../main/ipc-types'

const CATEGORIES = Object.keys(COMPANY_FACT_CATEGORY_LABELS) as CompanyFactCategory[]

/**
 * Company Truth: standing facts/rules about the actual business, kept
 * separate from any single conversation so Vergleichen/Team/Council can
 * optionally ground every run in the same facts instead of each provider
 * improvising its own (sometimes contradictory) assumptions. Content here
 * is entirely user-entered - this page is infrastructure, never seeded
 * with invented facts.
 */
export default function CompanyTruth(): React.JSX.Element {
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
          Feste Fakten und Regeln über dein Unternehmen (Produkt, Technik, Marketing, Recht, Entscheidungen) –
          unabhängig von einer einzelnen Konversation. Optional in Vergleichen/Team/Council einbeziehbar,
          damit alle Anbieter von denselben Fakten ausgehen, statt sich zu widersprechen.
        </p>

        <div className="field">
          <label>Kategorie</label>
          <select value={category} onChange={(e) => setCategory(e.target.value as CompanyFactCategory)} style={{ width: 260 }}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {COMPANY_FACT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Fakt / Regel</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="z.B. §34a Sachkunde PRO hat keine native iOS-App."
          />
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="primary" onClick={add} disabled={!text.trim()}>
            Hinzufügen
          </button>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        {loading && <span className="status-neutral">Lädt…</span>}
        {!loading && facts.length === 0 && (
          <span className="status-neutral">Noch keine Einträge – oben den ersten Fakt hinzufügen.</span>
        )}
        {!loading &&
          CATEGORIES.map((c) => {
            const inCategory = facts.filter((f) => f.category === c)
            if (inCategory.length === 0) return null
            return (
              <div key={c} style={{ marginBottom: 16 }}>
                <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--text-muted)' }}>
                  {COMPANY_FACT_CATEGORY_LABELS[c]}
                </h3>
                {inCategory.map((f) => (
                  <div key={f.id} className="row" style={{ alignItems: 'flex-start', marginBottom: 6 }}>
                    <span style={{ flex: 1, fontSize: 13 }}>{f.text}</span>
                    <button className="secondary" onClick={() => remove(f.id)}>
                      Löschen
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
