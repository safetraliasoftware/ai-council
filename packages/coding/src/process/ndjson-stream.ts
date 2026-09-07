import type { Readable } from 'node:stream'

/** Parses newline-delimited JSON from a stream, tolerant of partial lines and stray non-JSON output. */
export async function* parseNdjson(stream: Readable): AsyncGenerator<unknown> {
  let buffer = ''
  for await (const chunk of stream) {
    buffer += chunk.toString('utf-8')
    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (!line) continue
      const parsed = tryParse(line)
      if (parsed !== undefined) yield parsed
    }
  }
  const rest = buffer.trim()
  if (rest) {
    const parsed = tryParse(rest)
    if (parsed !== undefined) yield parsed
  }
}

function tryParse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
