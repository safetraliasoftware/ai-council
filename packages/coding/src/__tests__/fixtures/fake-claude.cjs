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
const prompt = pIndex >= 0 ? argv[pIndex + 1] : undefined

if (prompt === '__STREAM_OK__') {
  println({ type: 'system', subtype: 'init', session_id: 'sess-123' })
  println({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hallo ' } } })
  println({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Welt' } } })
  println({ type: 'result', result: 'Hallo Welt', session_id: 'sess-123', total_cost_usd: 0.0042 })
  process.exit(0)
}

if (prompt === '__DENIED_TOOLS__') {
  println({ type: 'system', subtype: 'init', session_id: 'sess-denied' })
  println({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] }
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

if (prompt === '__FAIL__') {
  process.stderr.write('simulated failure\n')
  process.exit(2)
}

if (prompt === '__ECHO_ARGS__') {
  println({ type: 'system', subtype: 'argv:' + JSON.stringify(argv) })
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
