import path from 'node:path'
import { TextDecoder } from 'node:util'

import { loadConfig } from '../src/config.ts'
import { runDevelopmentAgent } from '../src/development-agent.ts'
import { parseRequestedModel, type SessionModel } from '../src/development-model.ts'

const MAX_INPUT_BYTES = 64 * 1024
const MAX_TASK_CHARS = 20_000
const MAX_TITLE_CHARS = 1000
const MAX_TIMEOUT_MS = 60 * 60 * 1000
const MAX_ERROR_MESSAGE_CHARS = 500
const INPUT_KEYS = 'agentDir,devRoot,model,stateDir,task,taskKey,timeoutMs,title'
const TASK_KEY_PATTERN = /^development-[0-9a-f]{20}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeErrorName(error: unknown) {
  if (!(error instanceof Error) || !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name)) {
    return 'Error'
  }

  return error.name
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  return message.slice(0, MAX_ERROR_MESSAGE_CHARS)
}

function validateAbsolutePath(value: unknown, name: string) {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error(`worker ${name} must be an absolute path`)
  }

  return value
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

  if (Object.keys(parsed).sort().join(',') !== INPUT_KEYS) {
    throw new Error(`worker input must have exactly these fields: ${INPUT_KEYS}`)
  }

  const { task, taskKey, timeoutMs, title } = parsed
  const agentDir = validateAbsolutePath(parsed.agentDir, 'agentDir')
  const devRoot = validateAbsolutePath(parsed.devRoot, 'devRoot')
  const stateDir = validateAbsolutePath(parsed.stateDir, 'stateDir')
  const model = parseRequestedModel(parsed.model)

  if (typeof taskKey !== 'string' || !TASK_KEY_PATTERN.test(taskKey)) {
    throw new Error('worker taskKey is invalid')
  }

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

  return { agentDir, devRoot, model, stateDir, task, taskKey, title }
}

function finish(response: Record<string, unknown>, exitCode: number) {
  process.stdout.write(`${JSON.stringify(response)}\n`, () => {
    process.exit(exitCode)
  })
}

async function main() {
  // timeout で Araya から SIGTERM が届いたら session を abort し、終了を待ってから失敗を返す
  const controller = new AbortController()

  function abort() {
    controller.abort()
  }

  process.on('SIGTERM', abort)
  process.on('SIGINT', abort)

  // session の model が決まった後の失敗でも、使った model を返す
  let sessionModel: SessionModel | null = null

  function recordSessionModel(model: SessionModel) {
    sessionModel = model
  }

  try {
    const input = await readInput()

    console.log = () => undefined
    console.info = () => undefined
    console.warn = () => undefined
    console.error = () => undefined

    const result = await runDevelopmentAgent({
      ...input,
      env: loadConfig().env,
      signal: controller.signal,
      onSessionModel: recordSessionModel
    })

    if (controller.signal.aborted) {
      const error = new Error('development worker received a termination signal')
      error.name = 'AbortError'
      throw error
    }

    finish({ status: 'completed', summary: result.summary, model: result.model }, 0)
  } catch (error) {
    finish({ status: 'failed', errorName: safeErrorName(error), errorMessage: safeErrorMessage(error), model: sessionModel }, 1)
  }
}

void main()
