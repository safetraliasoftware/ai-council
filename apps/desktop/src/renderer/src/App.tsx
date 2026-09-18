import { useEffect, useState } from 'react'
import type { SettingsState } from '../../main/ipc-types'
import Settings from './components/Settings'
import TaskParallel from './components/TaskParallel'
import TaskTeam from './components/TaskTeam'
import TaskCouncil from './components/TaskCouncil'
import TaskCoding from './components/TaskCoding'
import ProjectSpec, { type ProjectSpecPrefill } from './components/ProjectSpec'
import UsageHistory from './components/UsageHistory'
import Help from './components/Help'

type Tab = 'parallel' | 'team' | 'council' | 'coding' | 'projectSpec' | 'settings' | 'usage' | 'help'

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('parallel')
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [projectSpecPrefill, setProjectSpecPrefill] = useState<ProjectSpecPrefill | null>(null)

  const reloadSettings = async (): Promise<void> => {
    setSettings(await window.api.settings.get())
  }

  useEffect(() => {
    reloadSettings()
    const openSettings = () => setTab('settings')
    window.addEventListener('ai-council:open-settings', openSettings)
    return () => window.removeEventListener('ai-council:open-settings', openSettings)
  }, [])

  // Coding's own implementerId doesn't map onto the Workflow tab - there
  // you pick Council providers/chair for spec generation, not a coding
  // implementer (that choice happens much later, per-task, once a taskgraph
  // exists) - so only the analysis text and working directory carry over.
  const handoffToWorkflow = (data: { task: string; workingDirectory: string }): void => {
    setProjectSpecPrefill({ id: Date.now(), goal: data.task, workingDirectory: data.workingDirectory })
    setTab('projectSpec')
  }

  // Only warn about a missing key for a provider actually configured to use
  // the API - a provider running via a local agent has nothing to warn
  // about, and "Automatisch" degrades gracefully on its own (see
  // participant-factory.ts) rather than silently failing.
  const anyKeyMissing = settings
    ? Object.values(settings).some((s) => s.backend === 'api' && !s.hasKey)
    : false

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
          className={`tab ${tab === 'projectSpec' ? 'active' : ''}`}
          onClick={() => setTab('projectSpec')}
        >
          Workflow
        </button>
        <button className={`tab ${tab === 'usage' ? 'active' : ''}`} onClick={() => setTab('usage')}>Verbrauch</button>
        <button className={`tab ${tab === 'help' ? 'active' : ''}`} onClick={() => setTab('help')}>Hilfe</button>
        <button
          className={`tab ${tab === 'settings' ? 'active' : ''}`}
          onClick={() => setTab('settings')}
        >
          Einstellungen {anyKeyMissing ? '⚠️' : ''}
        </button>
      </div>
      <div className="content">
        {tab === 'usage' && <UsageHistory />}
        {tab === 'help' && <Help />}
        {tab === 'settings' && settings && (
          <Settings settings={settings} onChange={reloadSettings} />
        )}
        {/*
          The five task tabs below stay mounted permanently (visibility
          toggled via style, never unmounted) once their prerequisites are
          ready - switching tabs must never lose a running job. Settings is
          deliberately excluded above: it has no running-job concept to
          preserve, and its own effect eagerly spawns CLI --version child
          processes for all three coding agents, which should only happen
          when a user actually opens it, not on every app start.
        */}
        {settings && (
          <>
            <div style={{ display: tab === 'parallel' ? 'block' : 'none' }}>
              <TaskParallel settings={settings} />
            </div>
            <div style={{ display: tab === 'team' ? 'block' : 'none' }}>
              <TaskTeam settings={settings} />
            </div>
            <div style={{ display: tab === 'council' ? 'block' : 'none' }}>
              <TaskCouncil settings={settings} />
            </div>
          </>
        )}
        <div style={{ display: tab === 'coding' ? 'block' : 'none' }}>
          <TaskCoding onHandoffToWorkflow={handoffToWorkflow} />
        </div>
        <div style={{ display: tab === 'projectSpec' ? 'block' : 'none' }}>
          <ProjectSpec prefill={projectSpecPrefill} />
        </div>
      </div>
    </div>
  )
}
