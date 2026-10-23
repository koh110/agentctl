import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

import { parseSessionModel, type DevelopmentModel } from './development-model.ts'

const MAX_STDOUT_BYTES = 128 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const MAX_TERMINATION_GRACE_MS = 60 * 1000
const DEFAULT_TERMINATION_GRACE_MS = 250
const ABANDONMENT_AFTER_KILL_MS = 3000
const WORKER_STDOUT_BYTES = 64 * 1024
const WORKER_STDERR_BYTES = 8 * 1024
const WORKER_TERMINATION_GRACE_MS = 10 * 1000
const VERIFICATION_OUTPUT_BYTES = 8 * 1024
const VERIFICATION_TERMINATION_GRACE_MS = 2000
const MAX_SUMMARY_CHARS = 4000
const MAX_WORKER_ERROR_MESSAGE_CHARS = 500
const WORKER_ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u

export type OutputOptions = {
  // strict: 上限超過または不正な UTF-8 で process を止める。tail: 止めずに末尾だけ残す
  mode: 'strict' | 'tail'
  limitBytes: number
}

export type BoundedProcessResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  terminationReason: 'timeout' | 'output_overflow' | 'invalid_utf8' | undefined
  terminationConfirmed: boolean
}

export type PiWorkerInput = {
  devRoot: string
  stateDir: string
  taskKey: string
  agentDir: string
  title: string
  task: string
  timeoutMs: number
  // 設定ファイルで指定した model。null なら Pi の設定で選ぶ
  model: DevelopmentModel | null
  env: Readonly<Record<string, string | undefined>>
}

export type VerificationCommandInput = {
  command: readonly string[]
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  timeoutMs: number
}

export type VerificationCommandResult = {
  status: 'passed' | 'failed' | 'timeout'
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  terminationConfirmed: boolean
  reason?: string
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function makeProcessError(
  message: string,
  terminationConfirmed: boolean,
  code: string,
  extra: Record<string, unknown> = {}
) {
  return Object.assign(new Error(message), { terminationConfirmed, code, ...extra })
}

function makeStrictCapture(limit: number, onFailure: (reason: 'output_overflow' | 'invalid_utf8') => void) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let bytes = 0
  let failed = false

  function consume(chunk: Buffer) {
    const remaining = Math.max(0, limit - bytes)
    const accepted = chunk.subarray(0, remaining)
    bytes += accepted.byteLength

    if (accepted.byteLength > 0 && !failed) {
      try {
        text += decoder.decode(accepted, { stream: true })
      } catch {
        failed = true
        onFailure('invalid_utf8')
      }
    }

    if (chunk.byteLength > accepted.byteLength && !failed) {
      failed = true
      onFailure('output_overflow')
    }
  }

  function finish() {
    if (failed) {
      return
    }

    try {
      text += decoder.decode()
    } catch {
      failed = true
      onFailure('invalid_utf8')
    }
  }

  return {
    consume,
    finish,
    get text() {
      return text
    },
    get bytes() {
      return bytes
    }
  }
}

function makeTailCapture(limit: number) {
  let tail = Buffer.alloc(0)
  let bytes = 0

  function consume(chunk: Buffer) {
    bytes += chunk.byteLength
    const combined = Buffer.concat([tail, chunk])
    tail = combined.byteLength > limit ? Buffer.from(combined.subarray(combined.byteLength - limit)) : combined
  }

  function finish() {}

  return {
    consume,
    finish,
    // 末尾で切れた先頭の文字や不正な byte は置換文字にする
    get text() {
      return new TextDecoder('utf-8').decode(tail)
    },
    get bytes() {
      return bytes
    }
  }
}

function makeCapture(options: OutputOptions, onFailure: (reason: 'output_overflow' | 'invalid_utf8') => void) {
  if (!Number.isInteger(options.limitBytes) || options.limitBytes < 0) {
    throw new Error('output limit must be a non-negative integer')
  }

  return options.mode === 'tail' ? makeTailCapture(options.limitBytes) : makeStrictCapture(options.limitBytes, onFailure)
}

export async function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    env?: Readonly<Record<string, string | undefined>>
    input?: string
    timeoutMs: number
    terminationGraceMs?: number
    stdout?: OutputOptions
    stderr?: OutputOptions
  }
) {
  // process group で子孫ごと止めるため Windows は対象外
  if (process.platform === 'win32') {
    throw new Error('bounded process groups are not supported on Windows')
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60 * 60 * 1000) {
    throw new Error('subprocess timeout must be between 1000 and 3600000 milliseconds')
  }

  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS

  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs < 0 || terminationGraceMs > MAX_TERMINATION_GRACE_MS) {
    throw new Error(`termination grace must be between 0 and ${MAX_TERMINATION_GRACE_MS} milliseconds`)
  }

  let terminationReason: BoundedProcessResult['terminationReason']
  let settled = false
  let forceKillTimer: NodeJS.Timeout | undefined
  let abandonmentTimer: NodeJS.Timeout | undefined
  let timeoutTimer: NodeJS.Timeout | undefined
  let spawnError: Error | undefined
  let resolveResult: ((result: BoundedProcessResult) => void) | undefined
  const stdoutCapture = makeCapture(options.stdout ?? { mode: 'strict', limitBytes: MAX_STDOUT_BYTES }, (reason) => {
    requestTermination(reason)
  })
  const stderrCapture = makeCapture(options.stderr ?? { mode: 'strict', limitBytes: MAX_STDERR_BYTES }, (reason) => {
    requestTermination(reason)
  })
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    detached: true,
    stdio: 'pipe',
    windowsHide: true
  })

  function killGroup(signal: NodeJS.Signals) {
    if (child.pid === undefined) {
      return
    }

    try {
      process.kill(-child.pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        return
      }
    }
  }

  function clearTimers() {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer)
    }

    if (forceKillTimer !== undefined) {
      clearTimeout(forceKillTimer)
    }

    if (abandonmentTimer !== undefined) {
      clearTimeout(abandonmentTimer)
    }
  }

  function settle(result: BoundedProcessResult) {
    if (settled) {
      return
    }

    settled = true
    clearTimers()
    resolveResult?.(result)
  }

  function abandon() {
    if (settled) {
      return
    }

    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    settle({
      exitCode: null,
      signal: null,
      stdout: stdoutCapture.text,
      stderr: stderrCapture.text,
      stdoutBytes: stdoutCapture.bytes,
      stderrBytes: stderrCapture.bytes,
      terminationReason,
      terminationConfirmed: false
    })
  }

  function requestTermination(reason: 'timeout' | 'output_overflow' | 'invalid_utf8') {
    if (terminationReason !== undefined || settled) {
      return
    }

    terminationReason = reason
    killGroup('SIGTERM')
    forceKillTimer = setTimeout(() => {
      killGroup('SIGKILL')
      abandonmentTimer = setTimeout(abandon, ABANDONMENT_AFTER_KILL_MS)
    }, terminationGraceMs)
  }

  const promise = new Promise<BoundedProcessResult>((resolve) => {
    resolveResult = resolve
  })

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutCapture.consume(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrCapture.consume(chunk)
  })
  child.once('error', (error) => {
    spawnError = error
  })
  child.once('close', (exitCode, signal) => {
    stdoutCapture.finish()
    stderrCapture.finish()
    settle({
      exitCode,
      signal,
      stdout: stdoutCapture.text,
      stderr: stderrCapture.text,
      stdoutBytes: stdoutCapture.bytes,
      stderrBytes: stderrCapture.bytes,
      terminationReason,
      terminationConfirmed: true
    })
  })
  child.stdin.once('error', (error) => {
    if (!isErrno(error, 'EPIPE') && terminationReason === undefined) {
      spawnError = error
    }
  })

  timeoutTimer = setTimeout(() => {
    requestTermination('timeout')
  }, options.timeoutMs)

  if (options.input === undefined) {
    child.stdin.end()
  } else {
    child.stdin.end(options.input, 'utf8')
  }

  const result = await promise

  if (spawnError !== undefined) {
    throw Object.assign(new Error(`subprocess could not be launched or its input pipe failed: ${spawnError.message}`), {
      code: 'subprocess_launch_failed'
    })
  }

  return result
}

// build 前は .ts、build 後は .js の worker を、この module と同じ package から探す
async function resolveWorkerPath() {
  const modulePath = fileURLToPath(import.meta.url)
  const packageRoot = path.resolve(path.dirname(modulePath), '..')
  const workerPath = path.join(packageRoot, 'bin', `development-worker${path.extname(modulePath)}`)
  let stat

  try {
    stat = await fs.lstat(workerPath)
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      throw makeProcessError(`development worker entrypoint was not found: ${workerPath}`, true, 'pi_worker_unavailable')
    }

    throw error
  }

  if (!stat.isFile()) {
    throw makeProcessError(`development worker entrypoint is not a regular file: ${workerPath}`, true, 'pi_worker_unavailable')
  }

  return workerPath
}

// model は、session の model が決まった後なら実際の session の値、決まる前の失敗なら null
function parseWorkerResponse(value: unknown) {
  if (!isRecord(value)) {
    return undefined
  }

  const keys = Object.keys(value).sort().join(',')

  if (keys === 'model,status,summary' && value.status === 'completed' && typeof value.summary === 'string') {
    const model = parseSessionModel(value.model)

    return model === undefined ? undefined : { status: 'completed' as const, summary: value.summary, model }
  }

  if (
    keys === 'errorMessage,errorName,model,status' &&
    value.status === 'failed' &&
    typeof value.errorName === 'string' &&
    WORKER_ERROR_NAME_PATTERN.test(value.errorName) &&
    typeof value.errorMessage === 'string' &&
    value.errorMessage.length <= MAX_WORKER_ERROR_MESSAGE_CHARS
  ) {
    const model = value.model === null ? null : parseSessionModel(value.model)

    return model === undefined
      ? undefined
      : { status: 'failed' as const, errorName: value.errorName, errorMessage: value.errorMessage, model }
  }

  return undefined
}

export function parsePiWorkerResult(result: BoundedProcessResult) {
  if (!result.terminationConfirmed) {
    throw makeProcessError('Pi worker process termination could not be confirmed', false, 'termination_unconfirmed')
  }

  if (result.terminationReason !== undefined) {
    const failure = result.terminationReason === 'timeout'
      ? { message: 'Pi worker timed out', code: 'agent_timeout' }
      : result.terminationReason === 'output_overflow'
        ? { message: 'Pi worker output exceeded its byte limit', code: 'pi_worker_output_overflow' }
        : { message: 'Pi worker output was not valid UTF-8', code: 'pi_worker_invalid_utf8' }
    throw makeProcessError(failure.message, true, failure.code)
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw makeProcessError('Pi worker returned an invalid response', true, 'pi_worker_invalid_response')
  }

  const response = parseWorkerResponse(parsed)

  if (response === undefined) {
    throw makeProcessError('Pi worker returned an invalid response', true, 'pi_worker_invalid_response')
  }

  if (response.status === 'failed') {
    throw makeProcessError(
      `Pi development worker failed: ${response.errorName}: ${response.errorMessage}`,
      true,
      'pi_worker_failed',
      {
        workerErrorName: response.errorName,
        workerErrorMessage: response.errorMessage,
        ...(response.model === null ? {} : { workerModel: response.model })
      }
    )
  }

  if (result.signal !== null) {
    throw makeProcessError('Pi worker exited after receiving a signal', true, 'pi_worker_signal_exit')
  }

  if (result.exitCode === null) {
    throw makeProcessError('Pi worker exit status is unavailable', true, 'pi_worker_exit_unknown')
  }

  if (result.exitCode !== 0) {
    throw makeProcessError('Pi worker exited with a non-zero status', true, 'pi_worker_nonzero_exit')
  }

  if (response.summary.trim().length === 0) {
    throw makeProcessError('Pi development worker returned an empty summary', true, 'pi_worker_empty_summary')
  }

  return { summary: response.summary.slice(0, MAX_SUMMARY_CHARS), model: response.model }
}

export async function runPiWorker(
  input: PiWorkerInput,
  dependencies: { workerPath?: string; terminationGraceMs?: number } = {}
) {
  const workerPath = dependencies.workerPath ?? await resolveWorkerPath()
  const result = await runBoundedCommand(process.execPath, [workerPath], {
    cwd: input.devRoot,
    env: { ...input.env, PI_CODING_AGENT_DIR: input.agentDir },
    input: JSON.stringify({
      agentDir: input.agentDir,
      devRoot: input.devRoot,
      model: input.model,
      stateDir: input.stateDir,
      task: input.task,
      taskKey: input.taskKey,
      timeoutMs: input.timeoutMs,
      title: input.title
    }),
    timeoutMs: input.timeoutMs,
    terminationGraceMs: dependencies.terminationGraceMs ?? WORKER_TERMINATION_GRACE_MS,
    stdout: { mode: 'strict', limitBytes: WORKER_STDOUT_BYTES },
    stderr: { mode: 'tail', limitBytes: WORKER_STDERR_BYTES }
  })

  return parsePiWorkerResult(result)
}

async function isDirectory(target: string) {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      return false
    }

    throw error
  }
}

function notStarted(reason: string) {
  const result: VerificationCommandResult = {
    status: 'failed',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    terminationConfirmed: true,
    reason
  }

  return result
}

export async function runVerificationCommand(input: VerificationCommandInput) {
  const executable = input.command[0]

  if (executable === undefined || executable === '') {
    return notStarted('launch_failed')
  }

  if (!await isDirectory(input.cwd)) {
    return notStarted('cwd_missing')
  }

  let result: BoundedProcessResult

  try {
    result = await runBoundedCommand(executable, input.command.slice(1), {
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      terminationGraceMs: VERIFICATION_TERMINATION_GRACE_MS,
      stdout: { mode: 'tail', limitBytes: VERIFICATION_OUTPUT_BYTES },
      stderr: { mode: 'tail', limitBytes: VERIFICATION_OUTPUT_BYTES }
    })
  } catch (error) {
    if (isErrno(error, 'subprocess_launch_failed')) {
      return notStarted('launch_failed')
    }

    throw error
  }

  const status = result.terminationReason === 'timeout'
    ? 'timeout'
    : result.exitCode === 0 && result.signal === null && result.terminationConfirmed
      ? 'passed'
      : 'failed'

  const verification: VerificationCommandResult = {
    status,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    terminationConfirmed: result.terminationConfirmed,
    ...(result.terminationConfirmed ? {} : { reason: 'termination_unconfirmed' })
  }

  return verification
}
