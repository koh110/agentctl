import { TextDecoder } from 'node:util'

import { runDevelopmentAgent } from '../src/development-agent.ts'

const MAX_INPUT_BYTES = 64 * 1024
const MAX_TASK_CHARS = 20_000
const MAX_TITLE_CHARS = 1000
const MAX_TIMEOUT_MS = 60 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeErrorName(error: unknown) {
  if (!(error instanceof Error) || !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)) {
    return 'Error'
  }

  return error.name
}

async function readInput() {
  const chunks: Buffer[] = []
  let byteLength = 0

  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error('worker input must be a byte stream')
    }

    byteLength += chunk.byteLength

    if (byteLength > MAX_INPUT_BYTES) {
      throw new Error('worker input exceeded its byte limit')
    }

    chunks.push(chunk)
  }

  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, byteLength))
  const parsed: unknown = JSON.parse(text)

  if (!isRecord(parsed)) {
    throw new Error('worker input must be a JSON object')
  }

  const keys = Object.keys(parsed).sort().join(',')

  if (keys !== 'task,timeoutMs,title') {
    throw new Error('worker input has unexpected fields')
  }

  const { task, timeoutMs, title } = parsed

  if (
    typeof title !== 'string' ||
    title.trim() === '' ||
    title.length > MAX_TITLE_CHARS ||
    title.includes('\0')
  ) {
    throw new Error('worker title is invalid')
  }

  if (
    typeof task !== 'string' ||
    task.trim() === '' ||
    task.length > MAX_TASK_CHARS ||
    task.includes('\0')
  ) {
    throw new Error('worker task is invalid')
  }

  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error('worker timeout is invalid')
  }

  return { title, task, timeoutMs }
}

async function main() {
  const input = await readInput()

  console.log = () => undefined
  console.info = () => undefined
  console.warn = () => undefined
  console.error = () => undefined

  const result = await runDevelopmentAgent(input)
  process.stdout.write(`${JSON.stringify({ status: 'completed', summary: result.summary })}\n`)
}

main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ status: 'failed', errorName: safeErrorName(error) })}\n`)
  process.exitCode = 1
})
