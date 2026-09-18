import { useState } from 'react'
import type { PermissionTier } from '@ai-council/coding'
import type { ProjectProfile } from '../../main/ipc-types'

/**
 * Shared between TaskCoding and TaskWorkflow - a saved shortcut for
 * "name + working directory (+ default permission tier)" so the same
 * project path doesn't need retyping/re-picking in every tab every time.
 * Deliberately doesn't touch executor selection - that varies more
 * per-task than the directory does.
 */

export interface ProjectPickerProps {
  currentWorkingDirectory: string
  currentPermissionTier: PermissionTier
  onApply: (workingDirectory: string, permissionTier?: PermissionTier) => void
}

export default function ProjectPicker({
  currentWorkingDirectory,
  currentPermissionTier,
  onApply
}: ProjectPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectProfile[]>([])
  const [loading, setLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    setLoading(true)
    setProjects(await window.api.projects.list())
    setLoading(false)
  }

  const select = async (project: ProjectProfile): Promise<void> => {
    onApply(project.workingDirectory, project.defaultPermissionTier)
    void window.api.projects.touch(project.id)
    setOpen(false)
  }

  const saveCurrent = async (): Promise<void> => {
    if (!newName.trim() || !currentWorkingDirectory.trim()) return
    setSaving(true)
    setError(undefined)
    try {
      await window.api.projects.save({
        name: newName.trim(),
        workingDirectory: currentWorkingDirectory,
        defaultPermissionTier: currentPermissionTier
      })
      setNewName('')
      setProjects(await window.api.projects.list())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    await window.api.projects.delete(id)
    setProjects(await window.api.projects.list())
  }

  return (
    <div>
      <button className="secondary" onClick={toggle}>
        {open ? 'Projekte schließen' : 'Projekte'}
      </button>

      {open && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          {loading && <span className="status-neutral">Lädt…</span>}
          {!loading && projects.length === 0 && (
            <span className="status-neutral">Noch keine gespeicherten Projekte.</span>
          )}
          {!loading &&
            projects.map((project) => (
              <div key={project.id} className="row" style={{ marginBottom: 4, alignItems: 'center' }}>
                <button
                  className="secondary"
                  onClick={() => select(project)}
                  style={{ textAlign: 'left', flex: 1 }}
                >
                  {project.name}
                </button>
                <span className="status-neutral" style={{ fontSize: 11 }}>
                  {project.workingDirectory}
                </span>
                <button className="secondary" onClick={() => remove(project.id)}>
                  Löschen
                </button>
              </div>
            ))}

          <div className="row" style={{ marginTop: 8 }}>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name für aktuelles Arbeitsverzeichnis"
            />
            <button
              className="secondary"
              onClick={saveCurrent}
              disabled={saving || !newName.trim() || !currentWorkingDirectory.trim()}
            >
              {saving ? 'Wird eingerichtet…' : 'Als Projekt speichern'}
            </button>
          </div>
          {error && <p className="error-text">{error}</p>}
        </div>
      )}
    </div>
  )
}
