import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { CodingExecutorId, ParticipantBackendChoice, SettingsState } from '../../../main/ipc-types'
import type { UiLanguage } from '../../../main/language-config'
import type { ExecutorAvailability } from '@ai-council/coding'
import CompanyTruth from './CompanyTruth'

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini', 'xai']
const LANGUAGES: { id: UiLanguage; label: string }[] = [
  { id: 'de', label: 'Deutsch' },
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' },
  { id: 'es', label: 'Español' }
]

// Partial - kept that way even though all four providers currently have a
// local CLI agent, since an absent entry means "API only" throughout this
// file and a future fifth provider might not have one.
export const LOCAL_AGENT_LABEL: Partial<Record<ProviderId, string>> = {
  anthropic: 'Claude Code',
  openai: 'Codex',
  gemini: 'Antigravity',
  xai: 'Grok Build'
}
export const LOCAL_AGENT_ID: Partial<Record<ProviderId, CodingExecutorId>> = {
  anthropic: 'claude-code-cli',
  openai: 'openai-codex-cli',
  gemini: 'google-antigravity-cli',
  xai: 'grok-build-cli'
}
// Binary names are verified against each executor's own DEFAULT_BINARY
// constant (packages/coding/src/executors/*.ts); docs URLs verified live
// via web search rather than guessed - install/auth steps change too often
// to hardcode commands here, so this only links to the official source.
export const LOCAL_AGENT_DOCS: Partial<Record<ProviderId, { binary: string; docsUrl: string }>> = {
  anthropic: { binary: 'claude', docsUrl: 'https://code.claude.com/docs/en/quickstart' },
  openai: { binary: 'codex', docsUrl: 'https://developers.openai.com/codex/cli' },
  gemini: { binary: 'agy', docsUrl: 'https://antigravity.google/docs/cli/getting-started/' },
  xai: { binary: 'grok', docsUrl: 'https://docs.x.ai/build/overview' }
}

export default function Settings({
  settings,
  onChange
}: {
  settings: SettingsState
  onChange: () => Promise<void>
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [keyDrafts, setKeyDrafts] = useState<Record<ProviderId, string>>({
    anthropic: '',
    openai: '',
    gemini: '',
    xai: ''
  })
  const [testStatus, setTestStatus] = useState<
    Record<ProviderId, { ok: boolean; error?: string; testing: boolean } | undefined>
  >({ anthropic: undefined, openai: undefined, gemini: undefined, xai: undefined })
  const [detectAll, setDetectAll] = useState<Partial<Record<CodingExecutorId, ExecutorAvailability>>>({})
  const [allowPaidApiFallback, setAllowPaidApiFallback] = useState(false)
  const [workspaceRoot, setWorkspaceRoot] = useState<string | undefined>()
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [language, setLanguage] = useState<UiLanguage>('de')
  const [localAgentBusy, setLocalAgentBusy] = useState<Partial<Record<ProviderId, { error?: string }>>>({})

  useEffect(() => {
    window.api.coding.detectAll().then(setDetectAll)
    window.api.settings.getAllowPaidApiFallback().then(setAllowPaidApiFallback)
    window.api.settings.getWorkspaceRoot().then((root) => {
      setWorkspaceRoot(root)
      setWorkspaceDraft(root ?? '')
    })
    window.api.settings.getLanguage().then(setLanguage)
    // Re-detect when the window regains focus - covers the common case of
    // installing/logging in via the terminal windows below, then alt-tabbing
    // back here, without needing a dedicated manual refresh button.
    const onFocus = (): void => {
      window.api.coding.detectAll().then(setDetectAll)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Only ever invoked from the local-agents section below, which already
  // filters to providers that have a LOCAL_AGENT_ID entry.
  const installLocalAgent = async (provider: ProviderId): Promise<void> => {
    setLocalAgentBusy((prev) => ({ ...prev, [provider]: {} }))
    const result = await window.api.coding.installExecutor(LOCAL_AGENT_ID[provider]!)
    setLocalAgentBusy((prev) => ({ ...prev, [provider]: { error: result.ok ? undefined : result.error } }))
  }

  const loginLocalAgent = async (provider: ProviderId): Promise<void> => {
    setLocalAgentBusy((prev) => ({ ...prev, [provider]: {} }))
    const result = await window.api.coding.loginExecutor(LOCAL_AGENT_ID[provider]!)
    setLocalAgentBusy((prev) => ({ ...prev, [provider]: { error: result.ok ? undefined : result.error } }))
  }

  const pickWorkspaceDirectory = async (): Promise<void> => {
    const dir = await window.api.coding.pickDirectory()
    if (dir) setWorkspaceDraft(dir)
  }

  const saveWorkspaceRoot = async (): Promise<void> => {
    setWorkspaceBusy(true)
    setWorkspaceError('')
    const result = await window.api.settings.setWorkspaceRoot(workspaceDraft)
    setWorkspaceBusy(false)
    if (!result.ok) {
      setWorkspaceError(result.error ?? t('settings.unknownError'))
      return
    }
    setWorkspaceRoot(workspaceDraft)
  }

  const changeBackend = async (provider: ProviderId, backend: ParticipantBackendChoice): Promise<void> => {
    await window.api.settings.setBackend(provider, backend)
    await onChange()
  }

  const toggleAllowFallback = async (value: boolean): Promise<void> => {
    setAllowPaidApiFallback(value)
    await window.api.settings.setAllowPaidApiFallback(value)
  }

  const saveKey = async (provider: ProviderId): Promise<void> => {
    const value = keyDrafts[provider].trim()
    if (!value) return
    await window.api.settings.setKey(provider, value)
    setKeyDrafts((d) => ({ ...d, [provider]: '' }))
    await onChange()
  }

  const clearKey = async (provider: ProviderId): Promise<void> => {
    await window.api.settings.clearKey(provider)
    setTestStatus((s) => ({ ...s, [provider]: undefined }))
    await onChange()
  }

  const changeModel = async (provider: ProviderId, model: string): Promise<void> => {
    await window.api.settings.setModel(provider, model)
    await onChange()
  }

  const test = async (provider: ProviderId): Promise<void> => {
    setTestStatus((s) => ({ ...s, [provider]: { ok: false, testing: true } }))
    const result = await window.api.settings.testKey(provider)
    setTestStatus((s) => ({ ...s, [provider]: { ...result, testing: false } }))
  }

  const changeLanguage = async (next: UiLanguage): Promise<void> => {
    setLanguage(next)
    await i18n.changeLanguage(next)
    await window.api.settings.setLanguage(next)
  }

  return (
    <div className="panel" style={{ maxWidth: 800 }}>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        {t('settings.apiKeyDisclaimer')}
      </p>
      {PROVIDERS.map((provider) => {
        const cfg = settings[provider]
        const status = testStatus[provider]
        return (
          <div key={provider} className="settings-row">
            <div>
              <span className={`provider-dot dot-${provider}`} />
              {PROVIDER_LABELS[provider]}
            </div>
            <div className="field" style={{ margin: 0 }}>
              {cfg.hasKey ? (
                <div className="row">
                  <span className="status-ok">{t('settings.keySaved')}</span>
                  <button className="link" onClick={() => clearKey(provider)}>
                    {t('settings.remove')}
                  </button>
                  <button className="link" onClick={() => test(provider)}>
                    {t('settings.test')}
                  </button>
                  {status?.testing && <span className="status-neutral">{t('settings.testing')}</span>}
                  {status && !status.testing && status.ok && (
                    <span className="status-ok">{t('settings.works')}</span>
                  )}
                  {status && !status.testing && !status.ok && (
                    <span className="status-bad">{status.error}</span>
                  )}
                </div>
              ) : (
                <div className="row">
                  <input
                    type="password"
                    placeholder={t('settings.apiKeyPlaceholder')}
                    value={keyDrafts[provider]}
                    onChange={(e) =>
                      setKeyDrafts((d) => ({ ...d, [provider]: e.target.value }))
                    }
                  />
                  <button className="secondary" onClick={() => saveKey(provider)}>
                    {t('settings.save')}
                  </button>
                </div>
              )}
            </div>
            <div>
              <input
                type="text"
                value={cfg.model}
                onChange={(e) => changeModel(provider, e.target.value)}
                title={t('settings.modelIdTitle')}
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              {LOCAL_AGENT_LABEL[provider] ? (
                <select
                  value={cfg.backend}
                  onChange={(e) => changeBackend(provider, e.target.value as ParticipantBackendChoice)}
                >
                  <option value="api">{t('settings.backendApi')}</option>
                  <option value="local">{t('settings.backendLocal', { agent: LOCAL_AGENT_LABEL[provider] })}</option>
                  <option value="auto">{t('settings.backendAuto')}</option>
                </select>
              ) : (
                <span className="status-neutral">{t('settings.backendApi')}</span>
              )}
              {cfg.backend !== 'api' && LOCAL_AGENT_ID[provider] &&
                (() => {
                  const status = detectAll[LOCAL_AGENT_ID[provider]!]
                  if (!status) return null
                  return (
                    <div className={status.installed ? 'status-ok' : 'status-bad'} style={{ fontSize: 12 }}>
                      {status.installed ? t('settings.availableAuth', { status: status.authStatus }) : t('settings.notInstalled')}
                    </div>
                  )
                })()}
            </div>
          </div>
        )
      })}
      <div className="row" style={{ marginTop: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <input
            type="checkbox"
            checked={allowPaidApiFallback}
            onChange={(e) => toggleAllowFallback(e.target.checked)}
            style={{ width: 'auto' }}
          />
          {t('settings.allowFallback')}
        </label>
      </div>

      <h3 style={{ marginTop: 32 }}>{t('settings.localAgentsHeading')}</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        {t('settings.localAgentsIntro')}
      </p>
      {PROVIDERS.filter((provider) => LOCAL_AGENT_ID[provider]).map((provider) => {
        const info = LOCAL_AGENT_DOCS[provider]!
        const status = detectAll[LOCAL_AGENT_ID[provider]!]
        const busy = localAgentBusy[provider]
        return (
          <div key={provider} style={{ marginBottom: 6 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <span className={`provider-dot dot-${provider}`} />
                {LOCAL_AGENT_LABEL[provider]} <span className="status-neutral">({info.binary})</span>
              </div>
              {status?.installed !== true && (
                <button className="secondary" onClick={() => installLocalAgent(provider)}>
                  {t('settings.installButton')}
                </button>
              )}
              {status?.installed === true && (
                <button className="secondary" onClick={() => loginLocalAgent(provider)}>
                  {t('settings.loginButton')}
                </button>
              )}
              <a href={info.docsUrl} target="_blank" rel="noreferrer">
                {t('settings.officialGuide')}
              </a>
              <span className={status?.installed ? 'status-ok' : 'status-bad'}>
                {status ? (status.installed ? t('settings.installedAuth', { status: status.authStatus }) : t('settings.notFound')) : t('settings.checking')}
              </span>
            </div>
            {busy && (
              <p className={busy.error ? 'error-text' : 'status-neutral'} style={{ margin: '4px 0 0', fontSize: 12 }}>
                {busy.error ? t('settings.installLoginFailed', { error: busy.error }) : t('settings.installLoginHint')}
              </p>
            )}
          </div>
        )
      })}

      <h3 style={{ marginTop: 32 }}>{t('settings.workspaceHeading')}</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        {t('settings.workspaceIntro')}
      </p>
      {workspaceRoot && <p className="status-ok">{t('settings.workspaceCurrentlySetup', { path: workspaceRoot })}</p>}
      <div className="row">
        <input
          type="text"
          value={workspaceDraft}
          onChange={(e) => setWorkspaceDraft(e.target.value)}
          placeholder={t('settings.workspacePlaceholder')}
        />
        <button className="secondary" onClick={pickWorkspaceDirectory}>
          {t('settings.browse')}
        </button>
        <button className="primary" disabled={workspaceBusy || !workspaceDraft.trim()} onClick={saveWorkspaceRoot}>
          {workspaceBusy ? t('settings.settingUp') : workspaceRoot ? t('settings.update') : t('settings.setup')}
        </button>
      </div>
      {workspaceError && <p className="error-text">{workspaceError}</p>}

      <h3 style={{ marginTop: 32 }}>{t('settings.languageHeading')}</h3>
      <p style={{ color: 'var(--text-muted)' }}>{t('settings.languageIntro')}</p>
      <select value={language} onChange={(e) => changeLanguage(e.target.value as UiLanguage)}>
        {LANGUAGES.map((l) => (
          <option key={l.id} value={l.id}>{l.label}</option>
        ))}
      </select>

      <h3 style={{ marginTop: 32 }}>{t('settings.companyTruthHeading')}</h3>
      <CompanyTruth />
    </div>
  )
}
