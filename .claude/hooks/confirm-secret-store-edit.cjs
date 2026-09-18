// PreToolUse hook (Write|Edit matcher): not a hard block, just an explicit
// "ask" with a reason - secret-store.ts manages the three AI providers' API
// keys, so an edit there deserves a deliberate confirmation instead of
// blending in with routine file edits.
'use strict'

let data = ''
process.stdin.on('data', (chunk) => { data += chunk })
process.stdin.on('end', () => {
  let input
  try {
    input = JSON.parse(data)
  } catch {
    process.exit(0)
  }
  const filePath = (input.tool_input && input.tool_input.file_path) || ''
  if (!/[\\/]secret-store\.ts$/i.test(filePath)) process.exit(0)
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'secret-store.ts verwaltet die API-Keys der drei KI-Provider - Änderung bewusst bestätigen.'
    }
  }))
  process.exit(0)
})
