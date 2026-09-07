import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

export interface SpawnOptions {
  cwd: string
  signal?: AbortSignal
}

export type ChildProcessStdinIgnored = ChildProcessByStdio<null, Readable, Readable>

export interface SpawnHandle {
  child: ChildProcessStdinIgnored
  /** Resolves with the exit code (null if killed by signal) once the process closes. */
  exitCode: Promise<number | null>
}

/**
 * Kills the whole process tree rooted at `pid`, not just that one process.
 *
 * A plain `child.kill()` only signals the immediate child. Here that child
 * is either `cmd.exe /c ...` (Windows) or, for any real CLI that is itself
 * a wrapper script, a shell - killing just the wrapper leaves the actual
 * long-running tool (e.g. Claude Code's own node process, and anything
 * *it* shells out to) orphaned and still running, which defeats "abort"
 * both practically and from a cost/safety standpoint.
 */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    // taskkill /t recurses the tree; /f forces termination. Fire-and-forget -
    // this is best-effort cleanup, not something callers need to await.
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  } else {
    // The process was started with `detached: true` below, which makes it
    // the leader of its own process group - signaling the negative PID
    // signals that whole group (POSIX group-kill convention).
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      // Already gone, or never got a group (e.g. exited before we could signal it).
    }
  }
}

/**
 * The only place in this package that touches child_process.spawn. Always
 * takes command + args as separate values - never build a single shell
 * command string, and never set `shell: true` (Node's own DEP0190 warning:
 * with shell:true, array arguments are concatenated for the shell to
 * re-parse, not safely escaped - the opposite of what "pass args as an
 * array" is supposed to guarantee).
 *
 * `.cmd`/`.bat` targets on Windows (like the `claude` npm shim) can't be
 * launched directly via CreateProcess (spawn EINVAL) and don't go through
 * PATHEXT resolution here. Per Node's own child_process docs, the safe
 * pattern is spawning `cmd.exe /c <command> <args...>` directly - this is
 * a normal argv-array spawn of a real executable (cmd.exe), not shell
 * interpretation of a string, so arguments stay individually escaped.
 *
 * Does NOT pass `signal` straight through to Node's spawn options, because
 * Node's built-in abort handling only kills the single immediate process -
 * see killTree() above for why that's not enough here.
 */
export function spawnProcess(command: string, args: string[], options: SpawnOptions): SpawnHandle {
  const [resolvedCommand, resolvedArgs] =
    process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', command, ...args]] : [command, args]

  const child = spawn(resolvedCommand, resolvedArgs, {
    cwd: options.cwd,
    windowsHide: true,
    // Only meaningful on POSIX (see killTree) - harmless no-op on Windows.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })

  if (options.signal) {
    const onAbort = (): void => {
      if (child.pid) killTree(child.pid)
    }
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  const exitCode = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code))
    child.on('error', () => resolve(null))
  })

  return { child, exitCode }
}
