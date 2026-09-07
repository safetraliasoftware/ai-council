import { useState } from 'react'
import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { SettingsState } from '../../../main/ipc-types'

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini']

export default function Settings({
  settings,
  onChange
}: {
  settings: SettingsState
  onChange: () => Promise<void>
}): React.JSX.Element {
  const [keyDrafts, setKeyDrafts] = useState<Record<ProviderId, string>>({
    anthropic: '',
    openai: '',
    gemini: ''
  })
  const [testStatus, setTestStatus] = useState<
    Record<ProviderId, { ok: boolean; error?: string; testing: boolean } | undefined>
  >({ anthropic: undefined, openai: undefined, gemini: undefined })

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

  return (
    <div className="panel" style={{ maxWidth: 800 }}>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        API-Keys werden ausschließlich verschlüsselt lokal auf diesem Rechner gespeichert (im
        Electron-Hauptprozess, via safeStorage) und verlassen diesen Prozess nie – auch nicht in
        Richtung dieser Oberfläche.
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
                  <span className="status-ok">Key gespeichert ✓</span>
                  <button className="link" onClick={() => clearKey(provider)}>
                    entfernen
                  </button>
                  <button className="link" onClick={() => test(provider)}>
                    testen
                  </button>
                  {status?.testing && <span className="status-neutral">prüfe…</span>}
                  {status && !status.testing && status.ok && (
                    <span className="status-ok">funktioniert ✓</span>
                  )}
                  {status && !status.testing && !status.ok && (
                    <span className="status-bad">{status.error}</span>
                  )}
                </div>
              ) : (
                <div className="row">
                  <input
                    type="password"
                    placeholder="API-Key einfügen"
                    value={keyDrafts[provider]}
                    onChange={(e) =>
                      setKeyDrafts((d) => ({ ...d, [provider]: e.target.value }))
                    }
                  />
                  <button className="secondary" onClick={() => saveKey(provider)}>
                    Speichern
                  </button>
                </div>
              )}
            </div>
            <div>
              <input
                type="text"
                value={cfg.model}
                onChange={(e) => changeModel(provider, e.target.value)}
                title="Modell-ID (bei Fehlern anpassen)"
              />
            </div>
            <div />
          </div>
        )
      })}
    </div>
  )
}
