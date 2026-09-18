#!/usr/bin/env node
// Stand-in for the real `claude` CLI, driven entirely by argv so tests are
// deterministic and never touch the network or a real Claude account.
const argv = process.argv.slice(2)

function println(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

if (argv.includes('--version')) {
  process.stdout.write('9.9.9 (Fake Claude)\n')
  process.exit(0)
}

if (argv[0] === 'auth' && argv[1] === 'status') {
  process.exit(process.env.FAKE_CLAUDE_AUTH_EXIT === '1' ? 1 : 0)
}

const pIndex = argv.indexOf('-p')
let prompt = pIndex >= 0 ? argv[pIndex + 1] : undefined
if (prompt === '-') {
  try {
    prompt = require('fs').readFileSync(0, 'utf-8')
  } catch {
    prompt = ''
  }
}

if (prompt === '__STREAM_OK__') {
  println({ type: 'system', subtype: 'init', session_id: 'sess-123' })
  println({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hallo ' } } })
  println({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Welt' } } })
  println({ type: 'result', result: 'Hallo Welt', session_id: 'sess-123', total_cost_usd: 0.0042 })
  process.exit(0)
}
if (prompt === '__RESULT_THEN_FAIL__') {
  println({ type: 'result', result: 'looks successful' })
  process.stderr.write('failure after result\n')
  process.exit(2)
}
if (prompt === '__ERROR_RESULT__') {
  println({ type: 'result', is_error: true, subtype: 'error_during_execution', errors: ['review failed'] })
  process.exit(0)
}

if (prompt === '__DENIED_TOOLS__') {
  println({ type: 'system', subtype: 'init', session_id: 'sess-denied' })
  println({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }] }
  })
  println({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'denied' }] }
  })
  println({
    type: 'result',
    result: '',
    session_id: 'sess-denied',
    permission_denials: [
      { tool_name: 'Bash', tool_use_id: 't1' },
      { tool_name: 'Edit', tool_use_id: 't2' }
    ]
  })
  process.exit(0)
}

if (prompt === '__COMMAND_OK__') {
  println({ type: 'system', subtype: 'init', session_id: 'sess-cmd' })
  println({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'npm test' } }] }
  })
  println({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: false, content: 'all good' }] }
  })
  println({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Tests laufen durch.' } }
  })
  println({ type: 'result', result: 'Tests laufen durch.', session_id: 'sess-cmd' })
  process.exit(0)
}

if (prompt === '__EXIT_CLEAN_NO_RESULT__') {
  println({ type: 'system', subtype: 'init', session_id: 'sess-no-result' })
  process.stderr.write('some diagnostic claude printed but never produced a result message\n')
  process.exit(0)
}

if (prompt === '__FAIL__') {
  process.stderr.write('simulated failure\n')
  process.exit(2)
}

if (typeof prompt === 'string' && prompt.startsWith('__ECHO_ARGS__')) {
  println({ type: 'system', subtype: 'argv:' + JSON.stringify({ argv, prompt }) })
  println({ type: 'result', result: 'ok' })
  process.exit(0)
}

if (prompt === '__HANG__') {
  const interval = setInterval(() => {
    println({ type: 'system', subtype: 'still-running' })
  }, 50)
  process.on('SIGTERM', () => {
    clearInterval(interval)
    process.exit(143)
  })
  // Safety net so the test process can never hang forever if SIGTERM handling
  // behaves differently across platforms.
  setTimeout(() => {
    clearInterval(interval)
    process.exit(0)
  }, 10000)
  return
}

println({ type: 'result', result: 'default' })
process.exit(0)
