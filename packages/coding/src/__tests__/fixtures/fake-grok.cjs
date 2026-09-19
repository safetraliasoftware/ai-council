#!/usr/bin/env node
// Stand-in for the real `grok` CLI, driven entirely by argv so tests are
// deterministic and never touch the network or a real xAI account. Event
// shapes for `system`/`result` are copied from a real captured run of the
// actual installed 1.0.34 binary (which failed at the auth step - see
// grok-build-cli.ts's class doc comment); `assistant`/`user`/`stream_event`
// shapes are carried over from fake-claude.cjs on the strength of the CLI's
// own documented claim that --output-format streaming-messages-json matches
// Anthropic's Messages API wire format, not independently re-verified yet.
const fs = require('node:fs')
const argv = process.argv.slice(2)

function println(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

if (argv.includes('--version')) {
  process.stdout.write('grok 9.9.9-fake (deadbeef)\n')
  process.exit(0)
}

if (argv[0] === 'models') {
  if (process.env.FAKE_GROK_UNAUTHENTICATED === '1') {
    process.stdout.write('You are not authenticated.\n\nDefault model: grok-4.6\n')
  } else {
    process.stdout.write('Default model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n')
  }
  process.exit(0)
}

const pIndex = argv.indexOf('-p')
let prompt = pIndex >= 0 ? argv[pIndex + 1] : undefined
const promptFileIndex = argv.indexOf('--prompt-file')
if (promptFileIndex >= 0) {
  prompt = fs.readFileSync(argv[promptFileIndex + 1], 'utf-8')
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

if (prompt === '__COMMAND_OK__') {
  println({ type: 'system', subtype: 'init', session_id: 'sess-cmd' })
  println({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'c1', name: 'run_terminal_command', input: { command: 'npm test' } }] }
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
  process.stderr.write('some diagnostic grok printed but never produced a result event\n')
  process.exit(0)
}

if (prompt === '__FAIL__') {
  process.stderr.write('simulated failure\n')
  process.exit(2)
}

if (typeof prompt === 'string' && prompt.includes('__ECHO_ARGS__')) {
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
  setTimeout(() => {
    clearInterval(interval)
    process.exit(0)
  }, 10000)
  return
}

// Fallback for anything else, including a huge prompt delivered via
// --prompt-file (its content doesn't match any special trigger above) -
// echo it back in the result so the test can confirm the full prompt
// travelled through intact rather than being truncated.
println({ type: 'result', result: typeof prompt === 'string' ? prompt : 'default' })
process.exit(0)
