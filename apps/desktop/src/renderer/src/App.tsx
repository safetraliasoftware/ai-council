import { useEffect, useState } from 'react'
import type { SettingsState } from '../../main/ipc-types'
import Settings from './components/Settings'
import TaskParallel from './components/TaskParallel'
import TaskTeam from './components/TaskTeam'
import TaskCouncil from './components/TaskCouncil'
import TaskCoding from './components/TaskCoding'

type Tab = 'parallel' | 'team' | 'council' | 'coding' | 'settings'

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('parallel')
  const [settings, setSettings] = useState<SettingsState | null>(null)

  const reloadSettings = async (): Promise<void> => {
    setSettings(await window.api.settings.get())
  }

  useEffect(() => {
    reloadSettings()
  }, [])

  const anyKeyMissing = settings ? Object.values(settings).some((s) => !s.hasKey) : false

  return (
    <div className="app">
      <div className="tabs">
        <button
          className={`tab ${tab === 'parallel' ? 'active' : ''}`}
          onClick={() => setTab('parallel')}
        >
          Vergleichen
        </button>
        <button className={`tab ${tab === 'team' ? 'active' : ''}`} onClick={() => setTab('team')}>
          Team
        </button>
        <button
          className={`tab ${tab === 'council' ? 'active' : ''}`}
          onClick={() => setTab('council')}
        >
          Council
        </button>
        <button className={`tab ${tab === 'coding' ? 'active' : ''}`} onClick={() => setTab('coding')}>
          Coding
        </button>
        <button
          className={`tab ${tab === 'settings' ? 'active' : ''}`}
          onClick={() => setTab('settings')}
        >
          Einstellungen {anyKeyMissing ? '⚠️' : ''}
        </button>
      </div>
      <div className="content">
        {tab === 'settings' && settings && (
          <Settings settings={settings} onChange={reloadSettings} />
        )}
        {tab === 'parallel' && settings && <TaskParallel settings={settings} />}
        {tab === 'team' && settings && <TaskTeam settings={settings} />}
        {tab === 'council' && settings && <TaskCouncil settings={settings} />}
        {tab === 'coding' && <TaskCoding />}
      </div>
    </div>
  )
}
