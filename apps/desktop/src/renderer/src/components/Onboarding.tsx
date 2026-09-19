import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CodingExecutorId, SettingsState } from '../../../main/ipc-types'
import type { ExecutorAvailability } from '@ai-council/coding'
import { readyProviderIds } from '../provider-ready'
import Settings from './Settings'

export default function Onboarding({
  settings,
  onSettingsChange,
  onComplete
}: {
  settings: SettingsState
  onSettingsChange: () => Promise<void>
  onComplete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [detectAll, setDetectAll] = useState<Partial<Record<CodingExecutorId, ExecutorAvailability>>>({})

  useEffect(() => {
    window.api.coding.detectAll().then(setDetectAll)
  }, [settings])

  const canContinue = readyProviderIds(settings, detectAll).length > 0

  const finish = async (): Promise<void> => {
    if (!canContinue) return
    await window.api.settings.setHasCompletedOnboarding(true)
    onComplete()
  }

  return (
    <div className="app">
      <div className="content">
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>{t('onboarding.welcomeHeading')}</h2>
          <p style={{ color: 'var(--text-muted)' }}>{t('onboarding.welcomeIntro')}</p>
        </div>
        <Settings settings={settings} onChange={onSettingsChange} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="primary" onClick={finish} disabled={!canContinue}>
            {t('onboarding.continueButton')}
          </button>
        </div>
        {!canContinue && (
          <p className="status-neutral" style={{ textAlign: 'right', marginTop: 8 }}>
            {t('onboarding.continueNeedsProvider')}
          </p>
        )}
      </div>
    </div>
  )
}
