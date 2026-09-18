import { runVerification } from '../verification'

/**
 * Re-reads PATH from the Windows registry (Machine + User scope) and merges
 * it into this process's own `process.env.PATH` - live-verified: after a
 * `winget install` completes in a separate process, the already-running
 * Electron/Node process still has the PATH it inherited at launch, and a
 * full app restart doesn't reliably pick up the change either (a Windows
 * env-var update is broadcast to Explorer, not force-propagated to every
 * already-running process tree). Reading straight from
 * [System.Environment]::GetEnvironmentVariable(...) sidesteps that entirely.
 * Best-effort: swallows any failure so a broken/missing PowerShell never
 * blocks the retry that follows - the existing "restart the app" fallback
 * still applies if this silently does nothing.
 */
export async function refreshWindowsPath(): Promise<void> {
  try {
    const result = await runVerification(
      {
        executable: 'powershell',
        args: [
          '-NoProfile',
          '-Command',
          "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')"
        ],
        timeoutMs: 15_000
      },
      process.cwd()
    )
    if (result.success && result.stdout.trim()) process.env.PATH = result.stdout.trim()
  } catch {
    // best effort - see doc comment above
  }
}
