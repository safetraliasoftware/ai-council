// PostToolUse hook (Write|Edit matcher): after a .ts/.tsx edit, typecheck the
// owning workspace package and surface any failure back into context - so a
// type error is caught right after the edit that caused it, not only at the
// end of a long edit sequence when `npm run typecheck` is finally run by hand.
'use strict'
const { execSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')

let data = ''
process.stdin.on('data', (chunk) => { data += chunk })
process.stdin.on('end', () => {
  let input
  try {
    input = JSON.parse(data)
  } catch {
    process.exit(0)
  }
  const filePath = (input.tool_response && input.tool_response.filePath) || (input.tool_input && input.tool_input.file_path) || ''
  if (!/\.(ts|tsx)$/i.test(filePath)) process.exit(0)
  const match = filePath.match(/[\\/](packages|apps)[\\/]([^\\/]+)[\\/]/)
  if (!match) process.exit(0)
  const pkg = match[2]

  try {
    execSync(`npm run typecheck --workspace=@ai-council/${pkg}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    process.exit(0)
  } catch (err) {
    const output = ((err.stdout ? err.stdout.toString() : '') + (err.stderr ? err.stderr.toString() : '')).slice(-4000)
    process.stdout.write(JSON.stringify({
      systemMessage: `Typecheck-Fehler in @ai-council/${pkg}`,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `npm run typecheck --workspace=@ai-council/${pkg} ist nach der letzten Änderung fehlgeschlagen:\n${output}`
      }
    }))
    process.exit(0)
  }
})
