import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import { LOCAL_AGENT_DOCS, LOCAL_AGENT_LABEL } from './Settings'

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini']

export default function Help(): React.JSX.Element {
  const { t } = useTranslation()
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.api.updates.getVersion().then(setVersion)
  }, [])

  const checkForUpdates = async (): Promise<void> => {
    setChecking(true)
    await window.api.updates.check()
    setChecking(false)
  }

  return (
    <div className="panel" style={{ maxWidth: 800 }}>
      <h3 style={{ marginTop: 0 }}>{t('help.overviewHeading')}</h3>
      <ul style={{ color: 'var(--text-muted)' }}>
        <li><strong>{t('app.tabParallel')}</strong> - {t('help.tabParallelDesc')}</li>
        <li><strong>Team</strong> - {t('help.tabTeamDesc')}</li>
        <li><strong>Council</strong> - {t('help.tabCouncilDesc')}</li>
        <li><strong>Coding</strong> - {t('help.tabCodingDesc')}</li>
        <li><strong>Workflow</strong> - {t('help.tabWorkflowDesc')}</li>
        <li><strong>{t('app.tabUsage')}</strong> - {t('help.tabUsageDesc')}</li>
        <li><strong>{t('app.tabSettings')}</strong> - {t('help.tabSettingsDesc')}</li>
      </ul>

      <h3 style={{ marginTop: 32 }}>{t('help.providerSetupHeading')}</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        {t('help.providerSetupIntro1')} <strong>{t('settings.backendApi')}</strong> {t('help.providerSetupIntro2')} <strong>{t('help.optionLocal')}</strong>{' '}
        {t('help.providerSetupIntro3')} <strong>{t('settings.backendAuto')}</strong> {t('help.providerSetupIntro4')}
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        {t('help.apiKeyTestIntro')}
        <strong> "{t('settings.test')}"</strong>{t('help.apiKeyTestOutro')}
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        {t('help.localAgentAuthIntro')}
        <strong> "unknown"</strong> {t('help.localAgentAuthOutro')}
      </p>
      {PROVIDERS.map((provider) => {
        const info = LOCAL_AGENT_DOCS[provider]
        return (
          <div key={provider} className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <div>
              <span className={`provider-dot dot-${provider}`} />
              {PROVIDER_LABELS[provider]} - {LOCAL_AGENT_LABEL[provider]}{' '}
              <span className="status-neutral">({info.binary})</span>
            </div>
            <a href={info.docsUrl} target="_blank" rel="noreferrer">{t('settings.officialGuide')}</a>
          </div>
        )
      })}

      <h3 style={{ marginTop: 32 }}>{t('help.workflowDetailHeading')}</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        {t('help.workflowIntro')}
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        {t('help.statusesIntro')}
      </p>
      <ul style={{ color: 'var(--text-muted)' }}>
        <li><strong>running</strong> - {t('help.statusRunningDesc')}</li>
        <li><strong>awaiting_permission</strong> - {t('help.statusAwaitingPermissionDesc')}</li>
        <li><strong>awaiting_install</strong> - {t('help.statusAwaitingInstallDesc')}</li>
        <li><strong>review</strong> - {t('help.statusReviewDesc')}</li>
        <li><strong>paused</strong> - {t('help.statusPausedDesc')}</li>
        <li><strong>failed</strong> - {t('help.statusFailedDesc')}</li>
        <li><strong>escalated</strong> - {t('help.statusEscalatedDesc')}</li>
      </ul>
      <p style={{ color: 'var(--text-muted)' }}>
        {t('help.budgetsInfo')}
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>{t('help.gitQuestionTitle')}</strong> {t('help.gitAnswerPart1')}{' '}
        <strong>{t('help.gitNoCommitBold')}</strong> {t('help.gitAnswerPart2')}{' '}
        <code>git init</code> {t('help.gitAnswerPart3')}
      </p>

      <h3 style={{ marginTop: 32 }}>{t('help.usageHeading')}</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        {t('help.usageIntro1')}
        <strong> {t('help.usageNotBold')}</strong> {t('help.usageIntro2')}
      </p>

      <h3 style={{ marginTop: 32 }}>{t('help.faqHeading')}</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>{t('help.faq1Question', { status: t('settings.notInstalled') })}</strong><br />
        {t('help.faq1Answer')}
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>{t('help.faq2Question')}</strong><br />
        {t('help.faq2Answer')}
      </p>

      <h3 style={{ marginTop: 32 }}>{t('help.versionUpdatesHeading')}</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        {t('help.installedVersionLabel')} <strong>{version || '…'}</strong>. {t('help.versionUpdatesInfo')}
      </p>
      <button className="secondary" disabled={checking} onClick={checkForUpdates}>
        {checking ? t('help.checkingUpdates') : t('help.checkForUpdatesButton')}
      </button>

      <h3 style={{ marginTop: 32 }}>{t('help.supportHeading')}</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        {t('help.supportIntro')}
      </p>
      <button
        className="secondary"
        onClick={() => { window.location.href = 'mailto:info@safetralia.de?subject=AI%20Council%20Support' }}
      >
        {t('help.contactSupport')}
      </button>
    </div>
  )
}
