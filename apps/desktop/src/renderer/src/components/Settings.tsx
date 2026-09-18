import { useEffect, useState } from 'react'
import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { CodingExecutorId, ParticipantBackendChoice, SettingsState } from '../../../main/ipc-types'
import type { ExecutorAvailability } from '@ai-council/coding'
import CompanyTruth from './CompanyTruth'

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini']

export const LOCAL_AGENT_LABEL: Record<ProviderId, string> = {
  anthropic: 'Claude Code',
  openai: 'Codex',
  gemini: 'Antigravity'
}
export const LOCAL_AGENT_ID: Record<ProviderId, CodingExecutorId> = {
  anthropic: 'claude-code-cli',
  openai: 'openai-codex-cli',
  gemini: 'google-antigravity-cli'
}
// Binary names are verified against each executor's own DEFAULT_BINARY
// constant (packages/coding/src/executors/*.ts); docs URLs verified live
// via web search rather than guessed - install/auth steps change too often
// to hardcode commands here, so this only links to the official source.
export const LOCAL_AGENT_DOCS: Record<ProviderId, { binary: string; docsUrl: string }> = {
  anthropic: { binary: 'claude', docsUrl: 'https://code.claude.com/docs/en/quickstart' },
  openai: { binary: 'codex', docsUrl: 'https://developers.openai.com/codex/cli' },
  gemini: { binary: 'agy', docsUrl: 'https://antigravity.google/docs/cli/getting-started/' }
}

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
  const [detectAll, setDetectAll] = useState<Partial<Record<CodingExecutorId, ExecutorAvailability>>>({})
  const [allowPaidApiFallback, setAllowPaidApiFallback] = useState(false)
  const [workspaceRoot, setWorkspaceRoot] = useState<string | undefined>()
  const [workspaceDraft, setWorkspaceDraft] = useState('')
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')

  useEffect(() => {
    window.api.coding.detectAll().then(setDetectAll)
    window.api.settings.getAllowPaidApiFallback().then(setAllowPaidApiFallback)
    window.api.settings.getWorkspaceRoot().then((root) => {
      setWorkspaceRoot(root)
      setWorkspaceDraft(root ?? '')
    })
  }, [])

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
      setWorkspaceError(result.error ?? 'Unbekannter Fehler.')
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
            <div className="field" style={{ margin: 0 }}>
              <select
                value={cfg.backend}
                onChange={(e) => changeBackend(provider, e.target.value as ParticipantBackendChoice)}
              >
                <option value="api">API</option>
                <option value="local">{LOCAL_AGENT_LABEL[provider]} (lokal)</option>
                <option value="auto">Automatisch</option>
              </select>
              {cfg.backend !== 'api' &&
                (() => {
                  const status = detectAll[LOCAL_AGENT_ID[provider]]
                  if (!status) return null
                  return (
                    <div className={status.installed ? 'status-ok' : 'status-bad'} style={{ fontSize: 12 }}>
                      {status.installed ? `verfügbar (Auth: ${status.authStatus})` : 'nicht installiert'}
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
          Bei "Automatisch": falls kein lokaler Agent verfügbar ist, auf die kostenpflichtige API ausweichen
        </label>
      </div>

      <h3 style={{ marginTop: 32 }}>Lokale KI-Agenten einrichten</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        Installation und Anmeldung laufen außerhalb dieser App über die offizielle Anleitung des jeweiligen
        Anbieters – der erkannte Status hier aktualisiert sich automatisch, sobald die CLI verfügbar und
        angemeldet ist.
      </p>
      {PROVIDERS.map((provider) => {
        const info = LOCAL_AGENT_DOCS[provider]
        const status = detectAll[LOCAL_AGENT_ID[provider]]
        return (
          <div key={provider} className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <div>
              <span className={`provider-dot dot-${provider}`} />
              {LOCAL_AGENT_LABEL[provider]} <span className="status-neutral">({info.binary})</span>
            </div>
            <a href={info.docsUrl} target="_blank" rel="noreferrer">
              Offizielle Anleitung
            </a>
            <span className={status?.installed ? 'status-ok' : 'status-bad'}>
              {status ? (status.installed ? `installiert (Auth: ${status.authStatus})` : 'nicht gefunden') : 'prüfe…'}
            </span>
          </div>
        )
      })}

      <h3 style={{ marginTop: 32 }}>Werkstatt-Ordner</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        Ein gemeinsamer Ordner für neue Projekte. Wird hier einmalig als Git-Repository eingerichtet; jedes
        neue Projekt legt sich danach als eigener Unterordner darin an, ohne dass "innerhalb eines anderen
        Git-Projekts" abgelehnt zu werden. Bereits bestehende, eigene Git-Projekte anderswo bleiben davon
        unberührt.
      </p>
      {workspaceRoot && <p className="status-ok">Aktuell eingerichtet: {workspaceRoot}</p>}
      <div className="row">
        <input
          type="text"
          value={workspaceDraft}
          onChange={(e) => setWorkspaceDraft(e.target.value)}
          placeholder="C:\Users\...\Projekte"
        />
        <button className="secondary" onClick={pickWorkspaceDirectory}>
          Durchsuchen…
        </button>
        <button className="primary" disabled={workspaceBusy || !workspaceDraft.trim()} onClick={saveWorkspaceRoot}>
          {workspaceBusy ? 'Richte ein…' : workspaceRoot ? 'Aktualisieren' : 'Einrichten'}
        </button>
      </div>
      {workspaceError && <p className="error-text">{workspaceError}</p>}

      <h3 style={{ marginTop: 32 }}>Company Truth</h3>
      <CompanyTruth />
    </div>
  )
}
