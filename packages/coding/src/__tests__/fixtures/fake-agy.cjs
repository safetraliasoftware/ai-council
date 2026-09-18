#!/usr/bin/env node
// Stand-in for the real `agy` CLI. Event shapes here are copied from two
// real captured runs of the actual Antigravity CLI (see the code review
// discussion this was built from), not guessed.
const fs = require('node:fs')
const argv = process.argv.slice(2)

function println(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

if (argv.includes('--version')) {
  process.stdout.write('9.9.9-fake\n')
  process.exit(0)
}

const pIndex = argv.indexOf('-p')
const prompt = pIndex >= 0 ? argv[pIndex + 1] : undefined
const conversationIndex = argv.indexOf('--conversation')
const resumedId = conversationIndex >= 0 ? argv[conversationIndex + 1] : undefined

function init(id) {
  println({ event: 'init', conversation_id: id, init: { cwd: process.cwd(), tools: [], permission_mode: 'request-review' } })
  println({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'user_input' } })
}

if (prompt === '__STREAM_OK__') {
  init('conv-123')
  println({
    event: 'step_update',
    step_update: { conversation_id: 'conv-123', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'Hallo Welt' }
  })
  println({ event: 'result', result: { conversation_id: 'conv-123', status: 'SUCCESS', response: 'Hallo Welt' } })
  process.exit(0)
}

if (prompt === '__COMMAND_OK__') {
  init('conv-cmd')
  println({
    event: 'step_update',
    step_update: { conversation_id: 'conv-cmd', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'npm test' } } }
  })
  println({
    event: 'step_update',
    step_update: { conversation_id: 'conv-cmd', step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'npm test' } } }
  })
  println({
    event: 'step_update',
    step_update: { conversation_id: 'conv-cmd', step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'Tests laufen durch.' }
  })
  println({ event: 'result', result: { conversation_id: 'conv-cmd', status: 'SUCCESS', response: 'Tests laufen durch.' } })
  process.exit(0)
}

if (prompt === '__DENIED__') {
  init('conv-denied')
  println({
    event: 'step_update',
    step_update: { conversation_id: 'conv-denied', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'rm -rf x' } } }
  })
  println({
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-denied',
      step_index: 1,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'rm -rf x' }, error: { type: 'TOOL_ERROR', message: 'permission denied' } }
    }
  })
  println({
    event: 'result',
    result: {
      conversation_id: 'conv-denied',
      status: 'CANCELED',
      response: '',
      denied_actions: [{ action: 'command', display_name: 'RunCommand' }]
    }
  })
  process.exit(0)
}

if (prompt === '__RESUME_ECHO__') {
  init(resumedId ? 'resumed:' + resumedId : 'conv-new')
  println({
    event: 'step_update',
    step_update: { conversation_id: 'x', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'echo' }
  })
  println({
    event: 'result',
    result: { conversation_id: resumedId ? 'resumed:' + resumedId : 'conv-new', status: 'SUCCESS', response: 'echo' }
  })
  process.exit(0)
}

if (prompt === '__ECHO_ARGS__') {
  init('conv-echo')
  println({
    event: 'step_update',
    step_update: { conversation_id: 'conv-echo', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'argv:' + JSON.stringify(argv) }
  })
  println({ event: 'result', result: { conversation_id: 'conv-echo', status: 'SUCCESS', response: 'argv:' + JSON.stringify(argv) } })
  process.exit(0)
}

// Mirrors the long-prompt-workaround wrapper text in google-antigravity-cli.ts
// ("Lies die Datei <name> ...") - reads the referenced file from the
// working directory and echoes its content back, the same way real agy's
// view_file tool was verified live to do for an arbitrarily long file.
const fileRefMatch = prompt && prompt.match(/^Lies die Datei ("(?:\\.|[^"\\])*")/)
if (fileRefMatch) {
  const file = JSON.parse(fileRefMatch[1])
  const content = fs.readFileSync(file, 'utf-8')
  init('conv-file-ref')
  println({ event: 'step_update', step_update: { conversation_id: 'conv-file-ref', step_index: 0, state: 'DONE', step_type: 'agent_response', text_delta: 'prompt-file:' + file } })
  println({
    event: 'step_update',
    step_update: { conversation_id: 'conv-file-ref', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'file-content:' + content }
  })
  println({ event: 'result', result: { conversation_id: 'conv-file-ref', status: 'SUCCESS', response: 'file-content:' + content } })
  process.exit(0)
}

if (prompt === '__EXIT_CLEAN_NO_RESULT__') {
  init('conv-no-result')
  process.stderr.write('some diagnostic agy printed but never produced a result event\n')
  process.exit(0)
}

if (prompt === '__FAIL__') {
  process.stderr.write('simulated agy failure\n')
  process.exit(2)
}

if (prompt === '__RESULT_THEN_FAIL__') {
  println({ event: 'result', result: { conversation_id: 'bad-exit', status: 'SUCCESS', response: 'looks successful' } })
  process.stderr.write('late process failure\n')
  process.exitCode = 7
  return
}

if (prompt === '__HANG__') {
  const interval = setInterval(() => {
    println({ event: 'step_update', step_update: { conversation_id: 'conv-hang', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'wait' } })
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

println({ event: 'result', result: { conversation_id: 'conv-default', status: 'SUCCESS', response: 'default' } })
process.exit(0)
