import { expect, it } from 'vitest'
import { RunLifecycle } from '../run-lifecycle'

it('registers work before it starts and waits for cancellation cleanup', async () => {
  const lifecycle = new RunLifecycle()
  let cancelled = false, persisted = false
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const work = lifecycle.track(() => { cancelled = true; finish() }, async () => { await gate; persisted = true })
  await lifecycle.shutdown()
  await work
  expect({ cancelled, persisted }).toEqual({ cancelled: true, persisted: true })
  expect(() => lifecycle.assertRunning()).toThrow(/beendet/)
})
