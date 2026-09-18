export interface SuggestedInstallCommand {
  executable: string
  args: string[]
  timeoutMs: number
}

const WINGET_TIMEOUT_MS = 600_000

function winget(...args: string[]): SuggestedInstallCommand {
  return { executable: 'winget', args: ['install', ...args, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], timeoutMs: WINGET_TIMEOUT_MS }
}

/**
 * Best-effort suggestion for the "install missing tool?" prompt - always
 * human-editable/reviewable before running, never executed blindly. Only
 * package IDs confirmed live via `winget search --id <id>` on this machine
 * are listed here (see packages/coding CHANGELOG/plan notes) - anything not
 * confirmed returns undefined rather than guessing a package ID that might
 * not exist or might install the wrong thing.
 */
export function suggestToolInstallCommand(executable: string): SuggestedInstallCommand | undefined {
  switch (executable.toLowerCase()) {
    case 'dotnet':
      return winget('--id', 'Microsoft.DotNet.SDK.8')
    case 'node':
    case 'npm':
      return winget('--id', 'OpenJS.NodeJS.LTS')
    case 'python':
    case 'python3':
      return winget('--id', 'Python.Python.3.12')
    case 'go':
      return winget('--id', 'GoLang.Go')
    default:
      return undefined
  }
}
