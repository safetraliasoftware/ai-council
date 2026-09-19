import { describe, expect, it } from 'vitest'
import { buildTerminalArgs } from '../local-agent-setup'

describe('buildTerminalArgs', () => {
  it('opens a new console via "cmd /c start" so the child gets real keyboard input', () => {
    const { command, args } = buildTerminalArgs('irm https://claude.ai/install.ps1 | iex')
    expect(command).toBe('cmd.exe')
    expect(args).toEqual(['/c', 'start', '""', 'powershell', '-NoExit', '-Command', 'irm https://claude.ai/install.ps1 | iex'])
  })

  it('passes the command through as a single argument, never concatenated into a shell string', () => {
    const { args } = buildTerminalArgs('claude')
    expect(args[args.length - 1]).toBe('claude')
    expect(args.some((a) => a.includes('&&') || a.includes(';'))).toBe(false)
  })
})
