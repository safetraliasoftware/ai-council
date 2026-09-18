import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Shared between TaskParallel, TaskTeam and TaskCouncil - only renders once
 * at least one Company Truth fact exists (nothing to include otherwise).
 * Purely informational (Company Truth is always included by the main
 * process - see ipc.ts's buildContent - there is no opt-out), hence no
 * checked/onChange props.
 */
export default function CompanyTruthToggle(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [factCount, setFactCount] = useState<number | undefined>()

  useEffect(() => {
    window.api.companyTruth.list().then((facts) => setFactCount(facts.length))
  }, [])

  if (!factCount) return null

  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
      <input
        type="checkbox"
        checked={true}
        disabled
        style={{ width: 'auto' }}
      />
      {t('companyTruthToggle.label', { count: factCount })}
    </label>
  )
}
