import { useEffect, useState } from 'react'
import type { ProviderId } from '@ai-council/shared'
import type { ExecutorAvailability } from '@ai-council/coding'
import type { CodingExecutorId, SettingsState } from '../../main/ipc-types'
import { LOCAL_AGENT_ID } from './components/Settings'

const ALL_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini', 'xai']

export function isProviderReady(
  id: ProviderId,
  settings: SettingsState,
  detectAll: Partial<Record<CodingExecutorId, ExecutorAvailability>>
): boolean {
  const entry = settings[id]
  if (!entry) return false
  const agentId = LOCAL_AGENT_ID[id]
  const local = agentId ? detectAll[agentId] : undefined
  const localOk = Boolean(local?.installed && local.authStatus !== 'unauthenticated')
  if (entry.backend === 'api') return entry.hasKey
  if (entry.backend === 'local') return localOk
  // 'auto' can use a saved key even when the fallback checkbox is off.
  return localOk || entry.hasKey
}

export function readyProviderIds(
  settings: SettingsState,
  detectAll: Partial<Record<CodingExecutorId, ExecutorAvailability>>
): ProviderId[] {
  return ALL_PROVIDERS.filter((id) => isProviderReady(id, settings, detectAll))
}

export function useReadyProviderSelection(settings?: SettingsState | null): [ProviderId[], (p: ProviderId) => void] {
  const [selected, setSelected] = useState<ProviderId[]>([])
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (touched) return
    let cancelled = false
    void Promise.all([
      settings ? Promise.resolve(settings) : window.api.settings.get(),
      window.api.coding.detectAll()
    ]).then(([resolved, detect]) => {
      if (cancelled) return
      setSelected(readyProviderIds(resolved, detect))
    })
    return () => {
      cancelled = true
    }
  }, [settings, touched])
  const toggle = (p: ProviderId): void => {
    setTouched(true)
    setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]))
  }
  return [selected, toggle]
}

export { ALL_PROVIDERS }
