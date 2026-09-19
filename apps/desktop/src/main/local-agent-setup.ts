import { spawn } from 'node:child_process'
import type { CodingExecutorId } from './ipc-types'

// Native, per-user standalone installers - no npm/Node.js and no admin
// rights required (confirmed against each provider's own docs at the time
// this was written). Kept as fixed strings here, never accepted from the
// renderer, matching the rest of this codebase's discipline of never
// shelling out to a renderer-supplied command.
const INSTALL_COMMANDS: Record<CodingExecutorId, string> = {
  'claude-code-cli': 'irm https://claude.ai/install.ps1 | iex',
  'openai-codex-cli': 'irm https://chatgpt.com/codex/install.ps1 | iex',
  'google-antigravity-cli': 'irm https://antigravity.google/cli/install.ps1 | iex',
  'grok-build-cli': 'irm https://x.ai/cli/install.ps1 | iex'
}

// Claude/Codex/Antigravity don't document a standalone non-interactive
// login command - all three prompt for a browser-based login the moment
// they're started interactively, so "log in" is simply "run the CLI
// itself". Grok Build has an explicit `grok login` command instead
// (confirmed via `grok login --help` on the real installed binary), which
// is more precise for a dedicated login button than starting a full
// interactive session would be.
const LOGIN_COMMANDS: Record<CodingExecutorId, string> = {
  'claude-code-cli': 'claude',
  'openai-codex-cli': 'codex',
  'google-antigravity-cli': 'agy',
  'grok-build-cli': 'grok login'
}

/**
 * Builds the argument array for opening a real, visible PowerShell window
 * running `command`. Pure and separately testable from the actual
 * `spawn()` call below - a real terminal window shouldn't pop up during a
 * test run.
 *
 * Spawning `powershell.exe` directly with `stdio: 'ignore'` was tried first
 * and doesn't work: with stdin redirected to NUL, the new console's read
 * loop hits EOF immediately and the whole host exits within a second or
 * two, even with `-NoExit` - caught live, the window opened and vanished
 * before a user could react. `cmd.exe /c start` is the standard Windows
 * trick instead: `start` explicitly allocates a fresh console with real
 * keyboard input for the program it launches, independent of the stdio
 * settings of the `cmd.exe` process that invoked it. The empty `""` title
 * argument is required - `start`'s first argument is otherwise
 * ambiguously treated as a window title instead of the program to run.
 */
export function buildTerminalArgs(command: string): { command: string; args: string[] } {
  return {
    command: 'cmd.exe',
    args: ['/c', 'start', '""', 'powershell', '-NoExit', '-Command', command]
  }
}

function openTerminal(command: string): { ok: boolean; error?: string } {
  try {
    const { command: exe, args } = buildTerminalArgs(command)
    spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function installExecutor(executorId: CodingExecutorId): { ok: boolean; error?: string } {
  return openTerminal(INSTALL_COMMANDS[executorId])
}

export function loginExecutor(executorId: CodingExecutorId): { ok: boolean; error?: string } {
  return openTerminal(LOGIN_COMMANDS[executorId])
}
