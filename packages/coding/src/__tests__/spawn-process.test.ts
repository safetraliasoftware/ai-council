import { describe, expect, it } from 'vitest'
import { getEventListeners } from 'node:events'
import { spawnProcess } from '../process/spawn-process'

/** A real, long-running child process with no shell/.cmd-shim layer involved. */
function longRunningNodeArgs(): string[] {
  return ['-e', 'setInterval(() => {}, 1000)']
}

describe('spawnProcess abort handling', () => {
  it('releases stdout readers as well as exitCode on the abort fallback', async () => {
    const controller = new AbortController()
    const handle = spawnProcess(process.execPath, longRunningNodeArgs(), { cwd: process.cwd(), signal: controller.signal }, 0)
    const reading = (async () => { try { for await (const _chunk of handle.child.stdout) { /* drain */ } } catch { /* destroyed on abort */ } })()
    controller.abort()
    await handle.exitCode
    await reading
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  }, 5000)

  it('removes the abort listener after normal exit', async () => {
    const controller = new AbortController()
    const handle = spawnProcess(process.execPath, ['-e', 'process.exit(0)'], { cwd: process.cwd(), signal: controller.signal })
    expect(await handle.exitCode).toBe(0)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('handles stdin closing before a large prompt is read without an uncaught EPIPE', async () => {
    const handle = spawnProcess(process.execPath, ['-e', 'process.exit(0)'], { cwd: process.cwd(), stdin: 'x'.repeat(4_000_000) })
    await handle.exitCode
  })
  it('confirms the kill when the process actually terminates within the grace period', async () => {
    const controller = new AbortController()
    const { exitCode, killConfirmed } = spawnProcess(
      'node',
      longRunningNodeArgs(),
      { cwd: process.cwd(), signal: controller.signal },
      5000
    )
    controller.abort()
    // A forcefully-killed process reports a real (platform-specific) exit
    // code via the genuine 'close' event, not null - null is reserved for
    // the timeout-fallback/'error' paths. Only killConfirmed() matters here.
    await exitCode
    expect(killConfirmed()).toBe(true)
  }, 15000)

  it(
    'REGRESSION (infinite hang on an unconfirmable kill): resolves exitCode via the grace-period fallback ' +
      'instead of waiting forever, and reports killConfirmed() false',
    async () => {
      // Caught live: a process abort whose kill could not be confirmed left
      // the whole await chain blocked forever, with no way for a caller to
      // ever move on. A grace period of 0ms makes this deterministic to
      // test - no real kill can complete that fast, so the fallback path is
      // exercised reliably rather than depending on OS timing.
      const controller = new AbortController()
      const { child, exitCode, killConfirmed } = spawnProcess(
        'node',
        longRunningNodeArgs(),
        { cwd: process.cwd(), signal: controller.signal },
        0
      )
      controller.abort()
      const code = await exitCode
      expect(code).toBeNull()
      expect(killConfirmed()).toBe(false)

      // The real process's fate is genuinely unconfirmed by design here -
      // clean it up directly so the test doesn't leak a lingering process.
      if (child.pid) {
        try {
          process.kill(child.pid)
        } catch {
          // already gone
        }
      }
    },
    15000
  )
})
