import { describe, expect, it } from 'vitest'
import { formatPermissionDenialWarning, parsePermissionDenialWarning } from '../permission-denial'

describe('formatPermissionDenialWarning / parsePermissionDenialWarning', () => {
  it('round-trips a single denied action', () => {
    const message = formatPermissionDenialWarning('Aktion(en)', 1, ['RunCommand'])
    expect(message).toBe('1 Aktion(en) wurden verweigert (keine Freigabe im aktuellen Rechte-Level): RunCommand')
    expect(parsePermissionDenialWarning(message)).toEqual(['RunCommand'])
  })

  it('round-trips multiple denied actions regardless of the "kind" label used', () => {
    const message = formatPermissionDenialWarning('Werkzeug-Aufruf(e)', 2, ['RunCommand', 'WriteFile'])
    expect(parsePermissionDenialWarning(message)).toEqual(['RunCommand', 'WriteFile'])
  })

  it('returns undefined for a warning message unrelated to permission denial', () => {
    expect(parsePermissionDenialWarning('Council-Modus (Read-only erzwungen): unerwarteter Befehl beobachtet: ls')).toBeUndefined()
  })

  it('returns undefined for an empty name list', () => {
    expect(parsePermissionDenialWarning(formatPermissionDenialWarning('Aktion(en)', 0, []))).toBeUndefined()
  })
})
