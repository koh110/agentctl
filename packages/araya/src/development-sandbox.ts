import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'] as const
const SYSTEM_BIND_PATHS = ['/usr', '/bin', '/lib', '/lib64'] as const
const ETC_DIRECTORY_BIND_PATHS = ['/etc/ca-certificates', '/etc/ssl', '/etc/pki/tls/certs'] as const
const ETC_FILE_BIND_PATHS = [
  '/etc/group',
  '/etc/hosts',
  '/etc/ld.so.cache',
  '/etc/localtime',
  '/etc/nsswitch.conf',
  '/etc/passwd',
  '/etc/resolv.conf'
] as const
const SAFE_LAUNCH_ENV = {
  HOME: '/tmp',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  TMPDIR: '/tmp'
} as const
const MAX_STDOUT_BYTES = 128 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const MAX_DEPENDENCY_TREE_ENTRIES = 200_000

export type BoundedProcessResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  terminationReason: 'timeout' | 'output_overflow' | 'invalid_utf8' | undefined
  terminationConfirmed: boolean
}

export type SandboxVerificationResult = {
  command: string[]
  exitCode: number
  stdout: string
  stderr: string
  timedOut?: boolean
  signal?: string | null
  terminationConfirmed: boolean
  error?: string
}

function isWithinOrEqual(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate)

  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function isErrno(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

function makeTerminationError(
  message: string,
  terminationConfirmed: boolean,
  code: string,
  extra: Record<string, string> = {}
) {
  return Object.assign(new Error(message), { terminationConfirmed, code, ...extra })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function makeOutputCapture(limit: number, onFailure: (reason: 'output_overflow' | 'invalid_utf8') => void) {
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
    }
  }
}

export async function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string
    env: Record<string, string>
    input?: string
    timeoutMs: number
    stdoutLimitBytes?: number
    stderrLimitBytes?: number
  }
): Promise<BoundedProcessResult> {
  if (process.platform !== 'linux') {
    throw new Error('bounded process groups are supported only on Linux')
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 60 * 60 * 1000) {
    throw new Error('subprocess timeout must be between 1000 and 3600000 milliseconds')
  }

  const stdoutLimit = options.stdoutLimitBytes ?? MAX_STDOUT_BYTES
  const stderrLimit = options.stderrLimitBytes ?? MAX_STDERR_BYTES
  let terminationReason: BoundedProcessResult['terminationReason']
  let settled = false
  let terminationConfirmed = true
  let forceKillTimer: NodeJS.Timeout | undefined
  let abandonmentTimer: NodeJS.Timeout | undefined
  let timeoutTimer: NodeJS.Timeout | undefined
  let spawnError: Error | undefined
  let resolveResult: ((result: BoundedProcessResult) => void) | undefined
  const stdoutCapture = makeOutputCapture(stdoutLimit, (reason) => {
    requestTermination(reason)
  })
  const stderrCapture = makeOutputCapture(stderrLimit, (reason) => {
    requestTermination(reason)
  })
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    detached: true,
    env: options.env,
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

  function requestTermination(reason: 'timeout' | 'output_overflow' | 'invalid_utf8') {
    if (terminationReason !== undefined || settled) {
      return
    }

    terminationReason = reason
    killGroup('SIGTERM')
    forceKillTimer = setTimeout(() => {
      killGroup('SIGKILL')
    }, 250)
    abandonmentTimer = setTimeout(() => {
      if (settled) {
        return
      }

      terminationConfirmed = false
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      settle({
        exitCode: null,
        signal: null,
        stdout: stdoutCapture.text,
        stderr: stderrCapture.text,
        terminationReason,
        terminationConfirmed
      })
    }, 3000)
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
    throw Object.assign(new Error('subprocess could not be launched or its input pipe failed'), {
      code: 'subprocess_launch_failed'
    })
  }

  return result
}

async function findExecutable(candidates: readonly string[]) {
  for (const candidate of candidates) {
    try {
      const realPath = await fs.realpath(candidate)
      const stat = await fs.stat(realPath)

      if (stat.isFile() && (stat.mode & 0o111) !== 0) {
        return realPath
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) {
        throw error
      }
    }
  }

  throw new Error('bubblewrap executable was not found in a supported system path')
}

async function appendSystemMounts(args: string[]) {
  for (const systemPath of SYSTEM_BIND_PATHS) {
    try {
      await fs.lstat(systemPath)
      args.push('--ro-bind', systemPath, systemPath)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw error
      }
    }
  }

  args.push('--dir', '/etc')

  for (const directoryPath of ETC_DIRECTORY_BIND_PATHS) {
    try {
      const realPath = await fs.realpath(directoryPath)
      const stat = await fs.stat(realPath)

      if (!stat.isDirectory()) {
        continue
      }

      args.push('--dir', directoryPath, '--ro-bind', realPath, directoryPath)
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) {
        throw error
      }
    }
  }

  for (const filePath of ETC_FILE_BIND_PATHS) {
    try {
      const realPath = await fs.realpath(filePath)
      const stat = await fs.stat(realPath)

      if (!stat.isFile()) {
        continue
      }

      args.push('--ro-bind', realPath, filePath)
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) {
        throw error
      }
    }
  }

  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/home')
}

async function appendRuntimeMount(args: string[]) {
  const nodePath = await fs.realpath(process.execPath)
  const exposedRoots = ['/usr', '/bin']

  if (exposedRoots.some((root) => isWithinOrEqual(nodePath, root))) {
    return nodePath
  }

  args.push('--dir', '/runtime', '--ro-bind', nodePath, '/runtime/node')
  return '/runtime/node'
}

async function validateDependencyTree(rootPath: string) {
  const pendingDirectories = [rootPath]
  const hardlinkCounts = new Map<string, { seen: number; linkCount: number }>()
  let entryCount = 0

  while (pendingDirectories.length > 0) {
    const directoryPath = pendingDirectories.pop()

    if (directoryPath === undefined) {
      continue
    }

    const entries = await fs.readdir(directoryPath)
    entryCount += entries.length

    if (entryCount > MAX_DEPENDENCY_TREE_ENTRIES) {
      throw new Error('project dependency tree exceeds its entry limit')
    }

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry)
      const stat = await fs.lstat(entryPath)

      if (stat.isSymbolicLink()) {
        continue
      }

      if (stat.isDirectory()) {
        pendingDirectories.push(entryPath)
        continue
      }

      if (!stat.isFile()) {
        throw new Error('project dependency tree contains an unsupported file type')
      }

      if (stat.nlink <= 1) {
        continue
      }

      const inodeKey = `${stat.dev}:${stat.ino}`
      const existing = hardlinkCounts.get(inodeKey)

      if (existing === undefined) {
        hardlinkCounts.set(inodeKey, { seen: 1, linkCount: stat.nlink })
      } else {
        existing.seen += 1
      }
    }
  }

  for (const hardlink of hardlinkCounts.values()) {
    if (hardlink.seen !== hardlink.linkCount) {
      throw new Error('project dependency tree contains an external hardlink')
    }
  }
}

async function resolveNodeModulesDirectory() {
  const resolvedPackagePath = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
  const resolvedRealPath = await fs.realpath(resolvedPackagePath)
  let currentPath = path.dirname(fileURLToPath(import.meta.url))

  while (currentPath !== path.dirname(currentPath)) {
    const nodeModulesPath = path.join(currentPath, 'node_modules')
    let packageRealPath: string | undefined

    try {
      packageRealPath = await fs.realpath(path.join(nodeModulesPath, '@earendil-works', 'pi-coding-agent'))
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) {
        throw error
      }
    }

    if (packageRealPath !== undefined && isWithinOrEqual(resolvedRealPath, packageRealPath)) {
      const stat = await fs.lstat(nodeModulesPath)

      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Pi SDK node_modules must be a real directory')
      }

      const realPath = await fs.realpath(nodeModulesPath)
      await validateDependencyTree(realPath)
      return realPath
    }

    currentPath = path.dirname(currentPath)
  }

  throw new Error('Pi SDK dependency directory could not be resolved')
}

function validateArgv(command: readonly string[]) {
  if (command.length === 0 || command.length > 64) {
    throw new Error('verification command must contain between 1 and 64 argv entries')
  }

  for (const argument of command) {
    if (argument.length === 0 || argument.length > 4096 || argument.includes('\0')) {
      throw new Error('verification argv contains an empty, oversized, or invalid argument')
    }
  }
}

async function buildVerificationArgs(
  projectRoot: string,
  workspacePath: string,
  command: readonly string[]
) {
  validateArgv(command)
  const bwrap = await findExecutable(BWRAP_CANDIDATES)
  const projectRealPath = await fs.realpath(projectRoot)
  const workspaceRealPath = await fs.realpath(workspacePath)
  const args = ['--unshare-all', '--die-with-parent', '--new-session']

  await appendSystemMounts(args)
  args.push('--dir', '/workspace', '--bind', workspaceRealPath, '/workspace')

  let hasGitMetadata = false

  try {
    await fs.lstat(path.join(workspaceRealPath, '.git'))
    hasGitMetadata = true
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error
    }
  }

  args.push('--overlay-src', workspaceRealPath, '--tmp-overlay', '/workspace')

  if (hasGitMetadata) {
    args.push('--ro-bind', '/dev/null', '/workspace/.git')
  }

  try {
    await fs.lstat(path.join(workspaceRealPath, 'node_modules'))
    throw new Error('worktree node_modules must be absent before sandboxed verification')
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error
    }
  }

  try {
    const dependencyPath = path.join(projectRealPath, 'node_modules')
    const dependencyStat = await fs.lstat(dependencyPath)

    if (dependencyStat.isSymbolicLink() || !dependencyStat.isDirectory()) {
      throw new Error('project node_modules must be a real directory')
    }

    const dependencyRealPath = await fs.realpath(dependencyPath)

    if (!isWithinOrEqual(dependencyRealPath, projectRealPath)) {
      throw new Error('project node_modules must remain inside the project')
    }

    await validateDependencyTree(dependencyRealPath)
    args.push('--dir', '/workspace/node_modules', '--ro-bind', dependencyRealPath, '/workspace/node_modules')
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error
    }
  }

  args.push(
    '--chdir', '/workspace',
    '--clearenv',
    '--setenv', 'HOME', '/tmp/home',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'LC_ALL', 'C.UTF-8',
    '--setenv', 'CI', '1',
    '--',
    ...command
  )

  return { bwrap, args }
}

export async function runSandboxedVerification(
  projectRoot: string,
  workspacePath: string,
  command: readonly string[],
  timeoutMs: number
): Promise<SandboxVerificationResult> {
  const { bwrap, args } = await buildVerificationArgs(projectRoot, workspacePath, command)
  const result = await runBoundedCommand(bwrap, args, {
    env: { ...SAFE_LAUNCH_ENV },
    timeoutMs,
    stdoutLimitBytes: MAX_STDOUT_BYTES,
    stderrLimitBytes: MAX_STDERR_BYTES
  })
  const failure = result.terminationReason === 'timeout'
    ? 'verification timed out'
    : result.terminationReason === 'output_overflow'
      ? 'verification output exceeded its byte limit'
      : result.terminationReason === 'invalid_utf8'
        ? 'verification output was not valid UTF-8'
        : result.terminationConfirmed === false
          ? 'verification process termination could not be confirmed'
          : undefined

  return {
    command: [...command],
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.terminationReason === 'timeout',
    signal: result.signal,
    terminationConfirmed: result.terminationConfirmed,
    error: failure
  }
}

async function resolveAgentRuntimePaths() {
  const sourceDirectory = path.dirname(fileURLToPath(import.meta.url))
  const packageRoot = await fs.realpath(path.resolve(sourceDirectory, '..'))
  const packageManifestPath = path.join(packageRoot, 'package.json')
  const packageManifestStat = await fs.lstat(packageManifestPath)

  if (!packageManifestStat.isFile() || packageManifestStat.isSymbolicLink()) {
    throw new Error('Araya package manifest is not a regular file')
  }

  const packageSourcePath = path.join(packageRoot, 'src')
  const sourceStat = await fs.lstat(packageSourcePath)

  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('Araya package source is not a real directory')
  }

  const sourceRealPath = await fs.realpath(packageSourcePath)

  if (!isWithinOrEqual(sourceRealPath, packageRoot)) {
    throw new Error('Araya package source must remain inside the package')
  }

  const packageBinPath = path.join(packageRoot, 'bin')
  const binStat = await fs.lstat(packageBinPath)

  if (!binStat.isDirectory() || binStat.isSymbolicLink()) {
    throw new Error('Araya package bin is not a real directory')
  }

  const binRealPath = await fs.realpath(packageBinPath)

  if (!isWithinOrEqual(binRealPath, packageRoot)) {
    throw new Error('Araya package bin must remain inside the package')
  }

  const workerExtension = path.extname(fileURLToPath(import.meta.url))
  const workerPath = path.join(binRealPath, `development-worker${workerExtension}`)
  const workerStat = await fs.lstat(workerPath)

  if (!workerStat.isFile() || workerStat.isSymbolicLink()) {
    throw new Error('development worker entrypoint is not a regular file')
  }

  const packageNodeModules = await resolveNodeModulesDirectory()

  return {
    packageManifestPath,
    packageSourcePath: sourceRealPath,
    packageBinPath: binRealPath,
    packageNodeModules,
    workerPath
  }
}

async function buildAgentArgs(
  workspacePath: string,
  agentDir: string,
  input: { title: string; task: string },
  timeoutMs: number
) {
  const bwrap = await findExecutable(BWRAP_CANDIDATES)
  const workspaceRealPath = await fs.realpath(workspacePath)
  const agentStat = await fs.lstat(agentDir)

  if (agentStat.isSymbolicLink() || !agentStat.isDirectory()) {
    throw new Error('Pi agent directory must be a real directory')
  }

  const agentRealPath = await fs.realpath(agentDir)
  const runtimePaths = await resolveAgentRuntimePaths()
  const args = ['--unshare-all', '--share-net', '--die-with-parent', '--new-session']
  const nodePath = await appendRuntimeMount(args)

  await appendSystemMounts(args)
  args.push(
    '--dir', '/app',
    '--ro-bind', runtimePaths.packageSourcePath, '/app/src',
    '--ro-bind', runtimePaths.packageBinPath, '/app/bin',
    '--ro-bind', runtimePaths.packageManifestPath, '/app/package.json',
    '--dir', '/app/node_modules',
    '--ro-bind', runtimePaths.packageNodeModules, '/app/node_modules'
  )
  args.push(
    '--dir', '/workspace',
    '--bind', workspaceRealPath, '/workspace',
    '--ro-bind', '/dev/null', '/workspace/.git',
    '--dir', '/pi-agent',
    '--ro-bind', agentRealPath, '/pi-agent',
    '--chdir', '/workspace',
    '--clearenv',
    '--setenv', 'HOME', '/tmp/home',
    '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin:/runtime',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'LC_ALL', 'C.UTF-8',
    '--setenv', 'PI_CODING_AGENT_DIR', '/pi-agent',
    '--',
    nodePath,
    path.join('/app/bin', path.basename(runtimePaths.workerPath))
  )

  return {
    args,
    bwrap,
    input: JSON.stringify({ title: input.title, task: input.task, timeoutMs })
  }
}

function isWorkerResponse(value: unknown): value is { status: 'completed'; summary: string } | { status: 'failed'; errorName: string } {
  if (!isRecord(value)) {
    return false
  }

  const keys = Object.keys(value).sort().join(',')

  return (
    keys === 'status,summary' && value.status === 'completed' && typeof value.summary === 'string'
  ) || (
    keys === 'errorName,status' &&
    value.status === 'failed' &&
    typeof value.errorName === 'string' &&
    /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(value.errorName)
  )
}

export function parsePiWorkerResult(result: BoundedProcessResult) {
  if (result.terminationConfirmed === false) {
    throw makeTerminationError(
      'Pi worker process termination could not be confirmed',
      false,
      'process_termination_unconfirmed'
    )
  }

  if (result.terminationReason !== undefined) {
    const failure = result.terminationReason === 'timeout'
      ? { message: 'Pi worker timed out', code: 'pi_worker_timeout' }
      : result.terminationReason === 'output_overflow'
        ? { message: 'Pi worker output exceeded its byte limit', code: 'pi_worker_output_overflow' }
        : { message: 'Pi worker output was not valid UTF-8', code: 'pi_worker_invalid_utf8' }
    throw makeTerminationError(failure.message, true, failure.code)
  }

  let response: unknown

  try {
    response = JSON.parse(result.stdout)
  } catch {
    throw makeTerminationError('Pi worker returned an invalid response', true, 'pi_worker_invalid_response')
  }

  if (!isWorkerResponse(response)) {
    throw makeTerminationError('Pi worker returned an invalid response', true, 'pi_worker_invalid_response')
  }

  if (response.status === 'failed') {
    throw makeTerminationError(
      'Pi development worker failed',
      true,
      'pi_worker_failed',
      { workerErrorName: response.errorName }
    )
  }

  if (result.signal !== null) {
    throw makeTerminationError('Pi worker exited after receiving a signal', true, 'pi_worker_signal_exit')
  }

  if (result.exitCode === null) {
    throw makeTerminationError('Pi worker exit status is unavailable', true, 'pi_worker_exit_unknown')
  }

  if (result.exitCode !== 0) {
    throw makeTerminationError('Pi worker exited with a non-zero status', true, 'pi_worker_nonzero_exit')
  }

  if (response.summary.trim().length === 0) {
    throw makeTerminationError('Pi development worker returned an empty summary', true, 'pi_worker_empty_summary')
  }

  return { summary: response.summary.slice(0, 4000) }
}

export async function runSandboxedPiAgent(input: {
  workspacePath: string
  agentDir: string
  title: string
  task: string
  timeoutMs: number
}) {
  const { args, bwrap, input: workerInput } = await buildAgentArgs(
    input.workspacePath,
    input.agentDir,
    { title: input.title, task: input.task },
    input.timeoutMs
  )
  const result = await runBoundedCommand(bwrap, args, {
    env: { ...SAFE_LAUNCH_ENV },
    input: workerInput,
    timeoutMs: input.timeoutMs,
    stdoutLimitBytes: MAX_STDOUT_BYTES,
    stderrLimitBytes: MAX_STDERR_BYTES
  })

  return parsePiWorkerResult(result)
}
