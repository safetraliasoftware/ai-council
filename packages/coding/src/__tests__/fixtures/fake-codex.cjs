#!/usr/bin/env node
// Stand-in for the real `codex` CLI. Event shapes here are copied from the
// verified @openai/codex-sdk source (sdk/typescript/src/{events,items}.ts),
// not guessed - see openai-codex-cli.ts for the citation.
const argv = process.argv.slice(2)

function println(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

if (argv.includes('--version')) {
  process.stdout.write('9.9.9 (Fake Codex)\n')
  process.exit(0)
}

const execIndex = argv.indexOf('exec')
const isResume = argv[execIndex + 1] === 'resume'
let prompt = argv[argv.length - 1]
if (prompt === '-') {
  try {
    prompt = require('fs').readFileSync(0, 'utf-8')
  } catch {
    prompt = ''
  }
}

if (prompt === '__STREAM_OK__') {
  println({ type: 'thread.started', thread_id: 'thread-abc' })
  println({ type: 'turn.started' })
  println({
    type: 'item.completed',
    item: { id: '1', type: 'reasoning', text: 'Plane die Aenderung...' }
  })
  println({
    type: 'item.completed',
    item: {
      id: '2',
      type: 'command_execution',
      command: 'npm test',
      aggregated_output: 'ok',
      exit_code: 0,
      status: 'completed'
    }
  })
  println({
    type: 'item.completed',
    item: {
      id: '3',
      type: 'file_change',
      changes: [
        { path: 'src/a.ts', kind: 'update' },
        { path: 'src/b.ts', kind: 'add' }
      ],
      status: 'completed'
    }
  })
  println({
    type: 'item.completed',
    item: { id: '4', type: 'agent_message', text: 'Fertig, Tests laufen.' }
  })
  println({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } })
  process.exit(0)
}

if (prompt === '__FAIL__') {
  println({ type: 'thread.started', thread_id: 'thread-fail' })
  println({ type: 'turn.started' })
  println({ type: 'turn.failed', error: { message: 'simulated codex failure' } })
  process.exit(1)
}

if (prompt === '__RESUME_ECHO__') {
  println({ type: 'thread.started', thread_id: isResume ? 'resumed:' + argv[execIndex + 2] : 'thread-new' })
  println({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'echo' } })
  process.exit(0)
}

if (typeof prompt === 'string' && prompt.startsWith('__ECHO_ARGS__')) {
  println({ type: 'thread.started', thread_id: 'thread-echo' })
  println({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'argv:' + JSON.stringify({ argv, prompt }) } })
  process.exit(0)
}

if (prompt === '__HANG__') {
  const interval = setInterval(() => {
    println({ type: 'turn.started' })
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

println({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'default' } })
process.exit(0)
