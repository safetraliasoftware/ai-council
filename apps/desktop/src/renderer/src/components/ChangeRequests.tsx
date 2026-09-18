import { useEffect, useRef, useState } from 'react'
import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { ChangeRequest, ChangeRequestSeverity } from '@ai-council/project-domain'
import type { ChangeRequestEvaluatedEnvelope } from '../../../main/ipc-types'

const ALL_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini']
const SEVERITIES: ChangeRequestSeverity[] = ['minor', 'architecture', 'security', 'compliance']
const STATUS_LABELS: Record<ChangeRequest['status'], string> = {
  pending: 'Wartet auf Vorschlag',
  council_approved: 'Vom Rat bewertet – wartet auf Entscheidung',
  human_approved: 'Genehmigt',
  rejected: 'Abgelehnt'
}

interface ChangeRequestsProps {
  projectId: string
  /**
   * Renders only the ChangeRequest(s) affecting this one task - meant to be
   * mounted directly inside that task's own card (see TaskGraphExecution.tsx),
   * since a human waiting on a specific task's escalation shouldn't have to
   * scroll away from it to resolve it. Caught live: with a long task list,
   * the previous single project-wide instance sat far above, requiring
   * exactly that scroll every time.
   */
  taskId: string
  onChanged: () => void | Promise<void>
  onRequestSpecRevision: (note: string) => void
}

/**
 * Mounted inside TaskGraphExecution.tsx's own per-task card (see `taskId`
 * above) - a ChangeRequest originates from an execution-time escalation on
 * one specific task, not from spec authorship, so it doesn't belong inside
 * ProjectSpec.tsx either. The one seam into that component is
 * onRequestSpecRevision (prefills its userNote textarea) - the human still
 * triggers "Neue Version vom Rat anfordern" there themselves, and comes
 * back here to link the resulting version once it's approved.
 */
export default function ChangeRequests({ projectId, taskId, onChanged, onRequestSpecRevision }: ChangeRequestsProps): React.JSX.Element | null {
  const [requests, setRequests] = useState<ChangeRequest[]>([])
  const [drafts, setDrafts] = useState<Record<string, { proposedChanges: string; severity: ChangeRequestSeverity }>>({})
  const [linkVersion, setLinkVersion] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<ProviderId[]>(ALL_PROVIDERS)
  const [chairId, setChairId] = useState<ProviderId>('anthropic')
  const [evaluating, setEvaluating] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const currentEvaluationId = useRef<string>('')
  const effectiveChairId = selected.includes(chairId) ? chairId : selected[0]

  const reload = async (): Promise<void> => {
    const list = (await window.api.changeRequest.list(projectId)).filter((cr) => cr.affectedTaskIds.includes(taskId))
    setRequests(list)
    setDrafts((prev) => {
      const next = { ...prev }
      for (const cr of list) {
        if (!next[cr.id]) next[cr.id] = { proposedChanges: cr.proposedChanges, severity: cr.severity }
      }
      return next
    })
  }

  useEffect(() => {
    void reload()
    const timer = setInterval(() => void reload(), 2000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, taskId])

  useEffect(() => {
    const off = window.api.changeRequest.onEvaluated((envelope: ChangeRequestEvaluatedEnvelope) => {
      if (envelope.projectId !== projectId || envelope.id !== currentEvaluationId.current) return
      currentEvaluationId.current = ''
      setEvaluating(null)
      if (!envelope.ok) setError(envelope.error)
      void reload()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, taskId])

  const act = async (id: string, action: () => Promise<{ ok: boolean; error?: string } | void>): Promise<void> => {
    setBusy(id)
    setError('')
    try {
      const result = await action()
      if (result && !result.ok) throw new Error(result.error)
      await reload()
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const saveDraft = (id: string): void => {
    const draft = drafts[id]
    if (!draft) return
    void act(id, () => window.api.changeRequest.updateProposal({ projectId, id, proposedChanges: draft.proposedChanges, severity: draft.severity }))
  }

  const evaluate = async (id: string): Promise<void> => {
    if (currentEvaluationId.current) return
    if (!effectiveChairId) { setError('Bitte mindestens einen Teilnehmer auswählen.'); return }
    const draft = drafts[id]
    if (!draft) return
    currentEvaluationId.current = id
    setEvaluating(id)
    setError('')
    try {
      const { runId } = await window.api.changeRequest.evaluate({ projectId, id, providers: selected, chairId: effectiveChairId, proposal: { ...draft } })
      if (!runId) throw new Error('Bewertung konnte nicht gestartet werden.')
    } catch (err) {
      currentEvaluationId.current = ''
      setEvaluating(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!requests.length) return null

  return (
    <section style={{ marginTop: 16 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Änderungsanfrage{requests.length > 1 ? 'n' : ''} zu diesem Task</h3>
      {error && <p className="error-text">{error}</p>}
      {applying && <button onClick={() => void window.api.taskGraph.abortTask(projectId, '').catch(err => setError(String(err)))}>Ersatz-Task-Erstellung abbrechen</button>}
      <div className="row" style={{ marginBottom: 8 }}>
        {ALL_PROVIDERS.map((p) => (
          <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
            <input
              type="checkbox"
              disabled={evaluating !== null}
              checked={selected.includes(p)}
              onChange={() => setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]))}
              style={{ width: 'auto' }}
            />
            {PROVIDER_LABELS[p]}
          </label>
        ))}
        <label style={{ margin: 0 }}>
          Vorsitz:
          <select disabled={evaluating !== null} value={effectiveChairId ?? ''} onChange={(e) => setChairId(e.target.value as ProviderId)} style={{ width: 140, marginLeft: 6 }}>
            {selected.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {requests.map((cr) => {
        const draft = drafts[cr.id] ?? { proposedChanges: cr.proposedChanges, severity: cr.severity }
        return (
          <div key={cr.id} className="result-card" style={{ marginBottom: 8, minHeight: 0 }}>
            <div className="result-header">
              <span className="badge">{STATUS_LABELS[cr.status]}</span>
              {cr.resultingSpecVersion && <span className="badge">→ Spec v{cr.resultingSpecVersion}</span>}
            </div>
            <div className="result-body">
              <div style={{ fontWeight: 600 }}>Grund (aus der Eskalation)</div>
              <div style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>{cr.reason}</div>

              {cr.status === 'pending' && (
                <>
                  <label>Vorschlag</label>
                  <textarea
                    disabled={evaluating !== null}
                    value={draft.proposedChanges}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [cr.id]: { ...draft, proposedChanges: e.target.value } }))}
                    onBlur={() => saveDraft(cr.id)}
                    placeholder="Was soll sich an der Spezifikation ändern, um diese Eskalation zu lösen?"
                    style={{ minHeight: 60 }}
                  />
                  <label>Schweregrad</label>
                  <select
                    disabled={evaluating !== null}
                    value={draft.severity}
                    onChange={(e) => {
                      const severity = e.target.value as ChangeRequestSeverity
                      setDrafts((prev) => ({ ...prev, [cr.id]: { ...draft, severity } }))
                      void act(cr.id, () => window.api.changeRequest.updateProposal({ projectId, id: cr.id, proposedChanges: draft.proposedChanges, severity }))
                    }}
                    style={{ width: 200 }}
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                    <button className="primary" disabled={evaluating !== null || selected.length === 0} onClick={() => void evaluate(cr.id)}>
                      {evaluating === cr.id ? 'Rat bewertet…' : 'Rat fragen'}
                    </button>
                  </div>
                </>
              )}

              {cr.councilRationale && (
                <>
                  <div style={{ fontWeight: 600, marginTop: 8 }}>Einschätzung des Rats</div>
                  {cr.councilRecommendation === 'reject' && (
                    <p className="error-text" style={{ margin: '4px 0' }}>
                      ⚠ Der Rat empfiehlt Ablehnung - die Entscheidung liegt trotzdem bei dir.
                    </p>
                  )}
                  <div style={{ whiteSpace: 'pre-wrap' }}>{cr.councilRationale}</div>
                </>
              )}

              {cr.status === 'council_approved' && (
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                  <button disabled={busy === cr.id} onClick={() => void act(cr.id, () => window.api.changeRequest.reject(projectId, cr.id))}>
                    Ablehnen
                  </button>
                  <button className="primary" disabled={busy === cr.id} onClick={() => void act(cr.id, () => window.api.changeRequest.approve(projectId, cr.id))}>
                    Genehmigen
                  </button>
                </div>
              )}

              {cr.status === 'human_approved' && !cr.appliedAt && (
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8, alignItems: 'center' }}>
                  <button
                    onClick={() =>
                      onRequestSpecRevision(
                        [cr.reason, cr.proposedChanges, cr.councilRationale ? `Council-Einschätzung: ${cr.councilRationale}` : '']
                          .filter(Boolean)
                          .join('\n\n')
                      )
                    }
                  >
                    Vorschlag in Spezifikation öffnen
                  </button>
                  <input
                    type="number"
                    placeholder="Neue Version-Nr."
                    value={linkVersion[cr.id] ?? ''}
                    onChange={(e) => setLinkVersion((prev) => ({ ...prev, [cr.id]: e.target.value }))}
                    style={{ width: 140 }}
                  />
                  <button
                    disabled={busy === cr.id || !linkVersion[cr.id]}
                    onClick={() => void act(cr.id, () => window.api.changeRequest.linkSpec(projectId, cr.id, Number(linkVersion[cr.id])))}
                  >
                    {cr.resultingSpecVersion ? 'Spec-Verknüpfung korrigieren' : 'Mit Spec-Version verknüpfen'}
                  </button>
                </div>
              )}

              {cr.status === 'human_approved' && cr.resultingSpecVersion && !cr.appliedAt && (
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                  <button className="primary" disabled={busy === cr.id} onClick={() => void act(cr.id, async () => {
                    setApplying(true)
                    try { return await window.api.changeRequest.apply(projectId, cr.id) }
                    finally { setApplying(false) }
                  })}>
                    Betroffene Tasks gezielt neu bewerten
                  </button>
                </div>
              )}

              {cr.appliedAt && <p className="status-ok">✓ Angewendet – Taskgraph aktualisiert.</p>}
              {cr.status === 'rejected' && <p className="status-neutral">Abgelehnt – Eskalation bleibt sonst ungelöst.</p>}
            </div>
          </div>
        )
      })}
    </section>
  )
}
