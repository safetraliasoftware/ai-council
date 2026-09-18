import { snapshotWorkspace, type WorkspaceSnapshot } from '../verification'

export interface PolicyDecision {
  outcome: 'allow' | 'deny'
  reason?: string
}

/**
 * Shared predicate behind both project-engine's reviewer-integrity check and
 * the council path's read-only violation check - previously two independent
 * implementations of the exact same fingerprint-before/after comparison.
 * Each caller keeps its own reaction (project-engine throws and fails the
 * attempt; the council path yields a non-fatal `policy_violation` event) -
 * only the detection itself and its canonical wording are shared. On a
 * mismatch, names the actual differing path(s) instead of a bare yes/no -
 * caught live: diagnosing a real violation down to "bin/obj rebuilt with a
 * non-deterministic PDB" cost far longer than it should have because the
 * old string-digest comparison gave no hint which file was involved.
 */
export function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): PolicyDecision {
  if (before.digest === after.digest) return { outcome: 'allow' }
  const changed: string[] = []
  for (const path of new Set([...before.entries.keys(), ...after.entries.keys()])) {
    if (before.entries.get(path) !== after.entries.get(path)) changed.push(path)
  }
  changed.sort()
  const shown = changed.slice(0, 5).join(', ') + (changed.length > 5 ? ` (+${changed.length - 5} weitere)` : '')
  return { outcome: 'deny', reason: `Das Arbeitsverzeichnis hat sich während eines schreibgeschützten Laufs verändert: ${shown}` }
}

export interface WorkspaceVerification extends PolicyDecision {
  /**
   * Set when an initial mismatch resolved itself by the retry - the run is
   * still allowed, but security-reviewed: forgiving a self-reverted write
   * silently would leave a genuine read-only violation that happens to be
   * timed to self-revert within the retry window indistinguishable from a
   * benign straggler. Callers should surface this as a non-fatal warning so
   * it stays visible in the attempt's own record instead of vanishing.
   */
  toleratedTransient?: string
}

/**
 * Wraps diffWorkspaceSnapshots() with one short retry before treating a
 * mismatch as a real violation. Caught live, twice, on two unrelated
 * projects: a lingering background process (a build server still flushing
 * an obj/*.cache file, or a second read-only reviewer/challenger sharing
 * the same worktree) can legitimately touch the workspace within this
 * window without any real policy violation. A single re-check after a
 * short delay tells a genuine violation (still different) apart from a
 * transient straggler (settles back to the same state) without needing to
 * know what specifically caused it.
 */
export async function verifyWorkspaceUnchanged(before: WorkspaceSnapshot, cwd: string, retryDelayMs = 500): Promise<WorkspaceVerification> {
  const first = diffWorkspaceSnapshots(before, await snapshotWorkspace(cwd))
  if (first.outcome === 'allow') return first
  await new Promise(resolve => setTimeout(resolve, retryDelayMs))
  const second = diffWorkspaceSnapshots(before, await snapshotWorkspace(cwd))
  return second.outcome === 'allow' ? { ...second, toleratedTransient: first.reason } : second
}
