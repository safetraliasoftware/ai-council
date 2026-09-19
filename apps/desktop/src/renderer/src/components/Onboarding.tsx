import { useTranslation } from 'react-i18next'
import type { SettingsState } from '../../../main/ipc-types'
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

  const finish = async (): Promise<void> => {
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
          <button className="primary" onClick={finish}>
            {t('onboarding.continueButton')}
          </button>
        </div>
      </div>
    </div>
  )
}
