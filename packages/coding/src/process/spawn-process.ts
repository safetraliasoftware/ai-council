import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import crossSpawn from 'cross-spawn'

export interface SpawnOptions {
  cwd: string
  signal?: AbortSignal
  /**
   * Written to the child's stdin and the stream closed immediately after
   * spawn, instead of leaving stdin ignored/closed. Some CLIs accept the
   * prompt this way instead of as a CLI argument - see openai-codex-cli.ts
   * for why that matters: a globally-installed npm .cmd shim (not inside
   * node_modules/.bin/) re-forwards its args through a *second* cmd.exe
   * layer via `%*`, which cross-spawn's double-escaping heuristic doesn't
   * detect (it only double-escapes shims matched by a node_modules/.bin/
   * path pattern). A long/complex argument can come out corrupted on the
   * far side even though it looks correctly escaped going in. Passing it
   * via stdin sidesteps cmd.exe's argument parsing entirely.
   */
  stdin?: string
}

export type ChildProcessStdinIgnored = ChildProcessByStdio<null, Readable, Readable>

export interface SpawnHandle {
  child: ChildProcessStdinIgnored
  /** Resolves with the exit code (null if killed by signal) once the process closes. */
  exitCode: Promise<number | null>
  /**
   * Only meaningful after `exitCode` has resolved following an abort.
   * True if the child's own 'close' event actually fired; false if
   * `exitCode` instead resolved via the grace-period fallback below,
   * meaning the kill could not be confirmed - the caller asked to stop
   * and we stopped waiting, but we don't actually know the process (or a
   * descendant that outlived it) is gone.
   */
  killConfirmed: () => boolean
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
    nodeSpawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
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
 * Uses `cross-spawn` instead of a hand-rolled `cmd.exe /c` wrapper. A
 * hand-rolled wrapper was tried first (spawning `cmd.exe /d /s /c <command>
 * <args...>` to work around `.cmd`/`.bat` targets like the `claude` npm
 * shim not being launchable directly via CreateProcess - spawn EINVAL, and
 * not going through PATHEXT resolution here). That approach was broken:
 * cmd.exe re-parses its *entire* received command line and treats
 * `& | ^ < > %` as control characters even *inside* double quotes (unlike
 * a real shell) - so any prompt/diff argument containing e.g. `&&` or `||`
 * (i.e. almost any real source diff) got silently truncated or split into
 * unrelated commands by cmd.exe itself, no matter how carefully Node
 * quoted the array elements before handing them to cmd.exe. Caught live:
 * a review-stage prompt embedding a Kotlin diff (full of `&&`/`||`) reached
 * the Codex CLI as a garbled fragment. cross-spawn is the standard,
 * widely-used fix for exactly this - it resolves `.cmd`/`.bat` targets via
 * PATHEXT and additionally caret-escapes cmd.exe's own metacharacters
 * before quoting, so arbitrary argument content (including full diffs)
 * survives intact on Windows. On POSIX it's a thin passthrough to
 * child_process.spawn.
 *
 * Does NOT pass `signal` straight through to Node's spawn options, because
 * Node's built-in abort handling only kills the single immediate process -
 * see killTree() above for why that's not enough here.
 */
const KILL_GRACE_PERIOD_MS = 8000
const liveProcesses = new Map<ChildProcessStdinIgnored, Promise<void>>()

/** Last shutdown barrier, including processes whose earlier abort timed out. */
export async function stopRemainingProcesses(timeoutMs = KILL_GRACE_PERIOD_MS): Promise<void> {
  const running = [...liveProcesses.entries()]
  for (const [child] of running) if (child.pid) killTree(child.pid)
  if (!running.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([Promise.all(running.map(([, closed]) => closed)), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Mindestens ein Kindprozess wurde noch nicht nachweislich beendet.')), timeoutMs)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
  killGracePeriodMs = KILL_GRACE_PERIOD_MS
): SpawnHandle {
  const rawChild = crossSpawn(command, args, {
    cwd: options.cwd,
    windowsHide: true,
    // Only meaningful on POSIX (see killTree) - harmless no-op on Windows.
    detached: process.platform !== 'win32',
    stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
  })

  // cross-spawn's types return a generic ChildProcess (stdout/stderr typed
  // as Readable | null); the stdio config above guarantees both are real
  // Readable streams at runtime, matching ChildProcessStdinIgnored. stdin
  // is intentionally not exposed further - the one-shot write above is the
  // only thing any caller in this package needs to do with it.
  const child = rawChild as unknown as ChildProcessStdinIgnored
  const closed = new Promise<void>(resolve => {
    child.once('close', () => { liveProcesses.delete(child); resolve() })
    child.once('error', () => {
      // ENOENT has no child. A failure after a successful spawn still needs close.
      if (!child.pid) { liveProcesses.delete(child); resolve() }
    })
  })
  liveProcesses.set(child, closed)

  let settled = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  let killConfirmedValue = true
  let resolveExitCode: (code: number | null) => void = () => {}
  const cleanup = (): void => {
    if (graceTimer) clearTimeout(graceTimer)
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
  }
  const exitCode = new Promise<number | null>((resolve) => {
    resolveExitCode = resolve
    child.on('close', (code) => {
      cleanup()
      settled = true
      resolve(code)
    })
    child.on('error', () => {
      cleanup()
      settled = true
      resolve(null)
    })
  })

  if (options.signal) {
    onAbort = (): void => {
      if (settled) return
      if (child.pid) killTree(child.pid)
      // Caught live: killTree's taskkill can report success on the process
      // we directly tracked while a descendant that inherited its stdout
      // pipe handle (a normal Windows CreateProcess behavior) survives and
      // keeps that pipe open - the 'close' event above then never fires.
      // Without this, every caller awaiting `exitCode` after an abort would
      // hang forever even though they correctly asked to stop. This does
      // NOT solve that underlying process-tree gap; it just guarantees an
      // abort always eventually unblocks its caller, and flags via
      // killConfirmed() when it had to give up rather than pretending the
      // kill definitely worked.
      graceTimer = setTimeout(() => {
        if (!settled) {
          settled = true
          killConfirmedValue = false
          resolveExitCode(null)
          // Executors await stdout before exitCode. Release both waits when
          // a descendant keeps inherited pipes open after cancellation.
          child.stdout.destroy()
          child.stderr.destroy()
          cleanup()
        }
      }, killGracePeriodMs)
    }
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  if (options.stdin !== undefined) {
    rawChild.stdin!.on('error', (err) => {
      // EPIPE is emitted by stdin itself, not by ChildProcess. Without a
      // listener a CLI exiting before reading the prompt crashes Electron.
      if (settled) return
      if (child.pid) killTree(child.pid)
      child.emit('error', err)
      child.stdout.destroy()
      child.stderr.destroy()
    })
    rawChild.stdin!.end(options.stdin, 'utf-8')
  }

  return { child, exitCode, killConfirmed: () => killConfirmedValue }
}
