import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import type { Opportunity } from './control-plane.ts'
import {
  runBoundedCommand,
  runPiWorker,
  runVerificationCommand,
  type PiWorkerInput,
  type VerificationCommandInput,
  type VerificationCommandResult
} from './development-process.ts'
import {
  computeTaskKey,
  createTaskState,
  readTaskState,
  type VerificationRecord,
  type WorktreeRecord
} from './development-worktrees.ts'

const MAX_TASK_TIMEOUT_MS = 60 * 60 * 1000
const MAX_TASK_CHARS = 20_000
const MAX_SUMMARY_CHARS = 4000
const MAX_FAILURE_DETAIL_CHARS = 500
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_CHANGED_FILES = 1000
const MAX_CHANGED_PATH_BYTES = 128 * 1024
const MAX_DIFF_BYTES = 256 * 1024
const DIFF_TRUNCATION_MARKER = `\n[diff truncated: the evidence limit is ${MAX_DIFF_BYTES} bytes across all worktrees]\n`
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024
const GIT_TIMEOUT_MS = 60_000
const GIT_CANDIDATES = ['/usr/bin/git', '/bin/git', '/usr/local/bin/git'] as const
// `-C` で指定した worktree 以外を git に操作させる環境変数は引き継がない
const GIT_REPOSITORY_ENV_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE'
] as const

export type DevelopmentExecution = {
  status: 'completed' | 'failed'
  evidence: Record<string, unknown>
}

export type DevelopmentTaskRunner = (opportunity: Opportunity) => Promise<DevelopmentExecution>

export type DevelopmentExecutorOptions = {
  devRoot: string
  dataDir: string
  env: Readonly<Record<string, string | undefined>>
  agentDir?: string
  taskTimeoutMs?: number
  verificationTimeoutMs?: number
}

type DevelopmentExecutorDependencies = {
  runAgent?: (input: PiWorkerInput) => Promise<{ summary: string }>
  runVerification?: (input: VerificationCommandInput) => Promise<VerificationCommandResult>
  // 差分の収集に使う git（test 用）
  gitExecutable?: string
}

type FailureReason =
  | 'invalid_task'
  | 'dev_root_missing'
  | 'task_state_already_exists'
  | 'termination_unconfirmed'
  | 'task_state_invalid'
  | 'evidence_collection_failed'
  | 'agent_timeout'
  | 'agent_failed'
  | 'no_changes'
  | 'verification_missing'
  | 'verification_failed'

type AgentOutcome =
  | { status: 'completed'; summary: string }
  | { status: 'failed' | 'timeout'; error: string; workerErrorName?: string; workerErrorMessage?: string }

type GitContext = {
  executable: string
  env: Record<string, string | undefined>
}

type DiffEvidence = {
  headSha: string
  headMoved: boolean
  changedFiles: string[]
  diff: string
  diffTruncated: boolean
  diffStat: { files: number; insertions: number; deletions: number; truncated: boolean }
}

type VerificationEvidence = {
  command: string[]
  cwd: string
  status: 'passed' | 'failed' | 'timeout' | 'not_run'
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  reason?: string
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

function isTerminationUnconfirmed(error: unknown) {
  return error instanceof Error && 'terminationConfirmed' in error && error.terminationConfirmed === false
}

function getErrorCode(error: unknown) {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }

  return 'development_agent_failed'
}

function getStringProperty(error: unknown, key: string) {
  if (error instanceof Error && key in error) {
    const value: unknown = Reflect.get(error, key)

    return typeof value === 'string' ? value : undefined
  }

  return undefined
}

function describeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  return message.slice(0, MAX_FAILURE_DETAIL_CHARS)
}

function validateTimeout(timeoutMs: number, name: string) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TASK_TIMEOUT_MS) {
    throw new Error(`${name} must be between 1000 and ${MAX_TASK_TIMEOUT_MS} milliseconds`)
  }
}

// intake と同じ検証を executor でもう一度行う
function validateOpportunity(opportunity: Opportunity) {
  if (opportunity.kind !== 'development' || opportunity.risk !== 'workspace') {
    throw new Error('development task requires kind development and risk workspace')
  }

  const unsupportedKeys = Object.keys(opportunity.payload).filter((key) => {
    return key !== 'task'
  })

  if (unsupportedKeys.length > 0) {
    throw new Error(`development payload accepts only task; unsupported key(s): ${unsupportedKeys.join(', ')}`)
  }

  const task = opportunity.payload.task

  if (typeof task !== 'string' || task.trim() === '' || task.length > MAX_TASK_CHARS || task.includes('\0')) {
    throw new Error(`development task must be a non-blank string of at most ${MAX_TASK_CHARS} characters without NUL`)
  }

  return task
}

async function resolveDevRoot(devRoot: string) {
  try {
    const devRootReal = await fs.realpath(devRoot)

    if ((await fs.stat(devRootReal)).isDirectory()) {
      return devRootReal
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) {
      throw error
    }
  }

  return undefined
}

async function findGitExecutable() {
  for (const candidate of GIT_CANDIDATES) {
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

  throw new Error(`git was not found in ${GIT_CANDIDATES.join(', ')}`)
}

function createGitEnv(env: Readonly<Record<string, string | undefined>>) {
  const gitEnv: Record<string, string | undefined> = {
    ...env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0'
  }

  for (const key of GIT_REPOSITORY_ENV_KEYS) {
    delete gitEnv[key]
  }

  return gitEnv
}

async function runGit(git: GitContext, worktreePath: string, args: readonly string[], stdoutLimitBytes = MAX_GIT_OUTPUT_BYTES) {
  const result = await runBoundedCommand(git.executable, [
    '-C', worktreePath,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.pager=cat',
    ...args
  ], {
    env: git.env,
    timeoutMs: GIT_TIMEOUT_MS,
    stdout: { mode: 'strict', limitBytes: stdoutLimitBytes },
    stderr: { mode: 'tail', limitBytes: 8 * 1024 }
  })

  if (!result.terminationConfirmed) {
    throw Object.assign(new Error(`git ${args[0] ?? ''} termination could not be confirmed`), { terminationConfirmed: false })
  }

  return result
}

async function runGitChecked(git: GitContext, worktreePath: string, args: readonly string[]) {
  const result = await runGit(git, worktreePath, args)

  if (result.terminationReason !== undefined || result.exitCode !== 0) {
    const detail = result.stderr.trim() === '' ? '' : `: ${result.stderr.trim().slice(0, MAX_FAILURE_DETAIL_CHARS)}`
    throw new Error(`git ${args.join(' ')} failed${detail}`)
  }

  return result.stdout
}

function parseNulSeparatedPaths(output: string) {
  const paths: string[] = []

  for (const entry of output.split('\0')) {
    if (entry === '') {
      continue
    }

    if (path.isAbsolute(entry) || entry.split(/[\\/]+/u).includes('..')) {
      throw new Error(`git reported an unexpected path: ${JSON.stringify(entry)}`)
    }

    paths.push(entry)
  }

  return paths
}

async function readBoundedFile(fileHandle: FileHandle, limit: number) {
  const buffer = Buffer.alloc(limit + 1)
  let length = 0

  while (length < buffer.byteLength) {
    const { bytesRead } = await fileHandle.read(buffer, length, buffer.byteLength - length, length)

    if (bytesRead === 0) {
      break
    }

    length += bytesRead
  }

  return {
    content: buffer.subarray(0, Math.min(length, limit)),
    truncated: length > limit
  }
}

async function collectUntrackedDiff(worktreePath: string, untrackedFiles: readonly string[]) {
  const chunks: string[] = []
  let bytes = 0
  let truncated = false

  for (const relativePath of untrackedFiles) {
    const candidate = path.resolve(worktreePath, relativePath)

    if (!isWithinOrEqual(candidate, worktreePath)) {
      throw new Error('untracked path is outside the worktree')
    }

    const displayedPath = JSON.stringify(relativePath.replaceAll('\\', '/'))
    let fileHandle

    try {
      fileHandle = await fs.open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    } catch (error) {
      if (isErrno(error, 'ELOOP')) {
        const note = `\n[untracked symlink omitted: ${displayedPath}]\n`
        chunks.push(note)
        bytes += Buffer.byteLength(note)
        continue
      }

      if (isErrno(error, 'ENOENT')) {
        throw new Error(`untracked file ${displayedPath} disappeared during evidence collection`)
      }

      throw error
    }

    try {
      const stat = await fileHandle.stat()

      if (!stat.isFile()) {
        const note = `\n[untracked non-regular file omitted: ${displayedPath}]\n`
        chunks.push(note)
        bytes += Buffer.byteLength(note)
        continue
      }

      const header = [
        `diff --git a/${displayedPath} b/${displayedPath}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${displayedPath}`
      ].join('\n')
      const remaining = Math.max(0, MAX_UNTRACKED_FILE_BYTES - bytes)
      const fileRead = await readBoundedFile(fileHandle, remaining)

      if (fileRead.truncated || stat.size > fileRead.content.byteLength) {
        const chunk = `${header}\n[untracked file content omitted or truncated: ${displayedPath}; bytes=${stat.size}]\n`
        chunks.push(chunk)
        bytes += Buffer.byteLength(chunk)
        truncated = true
        continue
      }

      let text: string

      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(fileRead.content)
      } catch {
        const chunk = `${header}\n[binary untracked file omitted: ${displayedPath}; bytes=${stat.size}]\n`
        chunks.push(chunk)
        bytes += Buffer.byteLength(chunk)
        continue
      }

      const lines = text.split('\n')

      if (text.endsWith('\n')) {
        lines.pop()
      }

      const hunk = lines.length === 0
        ? []
        : [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => {
            return `+${line}`
          })]
      const chunk = `${header}\n${hunk.join('\n')}${hunk.length === 0 ? '' : '\n'}`
      chunks.push(chunk)
      bytes += Buffer.byteLength(chunk)
    } finally {
      await fileHandle.close()
    }
  }

  return { diff: chunks.join(''), truncated }
}

function truncateUtf8(value: string, maxBytes: number) {
  const buffer = Buffer.from(value, 'utf8')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let end = Math.min(buffer.byteLength, maxBytes)

  while (end >= Math.max(0, maxBytes - 4)) {
    try {
      return decoder.decode(buffer.subarray(0, end))
    } catch {
      end -= 1
    }
  }

  return decoder.decode(buffer.subarray(0, Math.max(0, end)))
}

// 切り詰めの印も含めて budget 以内に収める。印が入らない budget では diff を残さない。
// git diff の出力が上限で止まったとき（forceMarker）は、budget 以内でも切り詰めたことが分かるように印を付ける
function limitDiff(diff: string, budget: number, forceMarker: boolean) {
  if (!forceMarker && Buffer.byteLength(diff) <= budget) {
    return diff
  }

  const markerBytes = Buffer.byteLength(DIFF_TRUNCATION_MARKER)

  if (budget < markerBytes) {
    return ''
  }

  return `${truncateUtf8(diff, budget - markerBytes)}${DIFF_TRUNCATION_MARKER}`
}

function summarizeDiff(diff: string, fileCount: number, truncated: boolean) {
  let insertions = 0
  let deletions = 0
  let inHunk = false

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }

    if (line.startsWith('@@ ')) {
      inHunk = true
      continue
    }

    if (!inHunk) {
      continue
    }

    if (line.startsWith('+')) {
      insertions += 1
    } else if (line.startsWith('-')) {
      deletions += 1
    }
  }

  return { files: fileCount, insertions, deletions, truncated }
}

// base SHA と作業 tree の差（commit 済み・未 commit・untracked）を集める
async function collectWorktreeDiff(git: GitContext, record: WorktreeRecord, diffBudget: number) {
  const worktreeReal = await fs.realpath(record.worktreePath)

  // 記録の検証の後に symlink へ置き換えられた worktree からは差分を集めない
  if (worktreeReal !== record.worktreePath) {
    throw new Error(`${record.worktreePath} resolves to ${worktreeReal}; recorded paths must not go through symlinks`)
  }

  const toplevel = (await runGitChecked(git, worktreeReal, ['rev-parse', '--show-toplevel'])).trim()

  if (await fs.realpath(toplevel) !== worktreeReal) {
    throw new Error(`${record.worktreePath} is not the root of a git worktree`)
  }

  const headSha = (await runGitChecked(git, worktreeReal, ['rev-parse', '--verify', 'HEAD'])).trim()
  const trackedFiles = parseNulSeparatedPaths(await runGitChecked(git, worktreeReal, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--name-only', '-z', record.baseSha, '--'
  ]))
  const untrackedFiles = parseNulSeparatedPaths(await runGitChecked(git, worktreeReal, [
    'ls-files', '--others', '--exclude-standard', '-z'
  ]))
  const changedFiles = [...new Set([...trackedFiles, ...untrackedFiles])].sort()

  if (changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error(`more than ${MAX_CHANGED_FILES} files changed in ${record.worktreePath}`)
  }

  if (Buffer.byteLength(changedFiles.join('\n')) > MAX_CHANGED_PATH_BYTES) {
    throw new Error(`changed paths exceed ${MAX_CHANGED_PATH_BYTES} bytes in ${record.worktreePath}`)
  }

  const trackedDiff = await runGit(git, worktreeReal, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', '--unified=3', record.baseSha, '--'
  ], diffBudget)

  if (trackedDiff.exitCode === null && trackedDiff.terminationReason !== 'output_overflow') {
    throw new Error('git diff did not finish')
  }

  if (trackedDiff.terminationReason === 'timeout' || trackedDiff.terminationReason === 'invalid_utf8') {
    throw new Error(`git diff failed (${trackedDiff.terminationReason})`)
  }

  if (trackedDiff.terminationReason === undefined && trackedDiff.exitCode !== 0) {
    throw new Error(`git diff exited with ${String(trackedDiff.exitCode)}`)
  }

  const untracked = await collectUntrackedDiff(worktreeReal, untrackedFiles)
  const diff = `${trackedDiff.stdout}${untracked.diff}`
  const trackedOverflowed = trackedDiff.terminationReason === 'output_overflow'
  const limitedDiff = limitDiff(diff, diffBudget, trackedOverflowed)
  const diffTruncated = trackedOverflowed || untracked.truncated || limitedDiff !== diff

  const evidence: DiffEvidence = {
    headSha,
    headMoved: headSha !== record.baseSha,
    changedFiles,
    diff: limitedDiff,
    diffTruncated,
    diffStat: summarizeDiff(limitedDiff, changedFiles.length, diffTruncated)
  }

  return evidence
}

// 検証の cwd が symlink などで worktree の外を指していないことを確かめる。存在しない cwd は検証の実行側で cwd_missing にする
async function checkVerificationCwd(cwd: string, worktreePath: string) {
  let cwdReal: string

  try {
    cwdReal = await fs.realpath(cwd)
  } catch (error) {
    return isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') ? undefined : 'cwd_unresolvable'
  }

  return isWithinOrEqual(cwdReal, worktreePath) ? undefined : 'cwd_outside_worktree'
}

function notRun(record: VerificationRecord, reason: string) {
  const evidence: VerificationEvidence = {
    command: [...record.command],
    cwd: record.cwd,
    status: 'not_run',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    reason
  }

  return evidence
}

function toWorktreeEvidence(record: WorktreeRecord, diff: DiffEvidence, verifications: VerificationEvidence[]) {
  return {
    repository: record.repository,
    worktreePath: record.worktreePath,
    branch: record.branch,
    base: record.base,
    baseSha: record.baseSha,
    headSha: diff.headSha,
    headMoved: diff.headMoved,
    excludeAdded: record.excludeAdded,
    changedFiles: diff.changedFiles,
    diffStat: diff.diffStat,
    diff: diff.diff,
    diffTruncated: diff.diffTruncated,
    verifications
  }
}

function toWorktreeLocation(record: WorktreeRecord) {
  return {
    repository: record.repository,
    worktreePath: record.worktreePath,
    branch: record.branch,
    base: record.base,
    baseSha: record.baseSha,
    excludeAdded: record.excludeAdded
  }
}

function agentEvidence(agent: AgentOutcome) {
  if (agent.status === 'completed') {
    return { summary: agent.summary }
  }

  return {
    agentError: agent.error,
    ...(agent.workerErrorName === undefined ? {} : { workerErrorName: agent.workerErrorName }),
    ...(agent.workerErrorMessage === undefined ? {} : { workerErrorMessage: agent.workerErrorMessage })
  }
}

export function createDevelopmentExecutor(
  options: DevelopmentExecutorOptions,
  dependencies: DevelopmentExecutorDependencies = {}
) {
  const taskTimeoutMs = options.taskTimeoutMs ?? 20 * 60 * 1000
  const verificationTimeoutMs = options.verificationTimeoutMs ?? 5 * 60 * 1000
  const agentDir = options.agentDir ?? path.join(os.homedir(), '.pi', 'agent')
  const runAgent = dependencies.runAgent ?? ((input: PiWorkerInput) => {
    return runPiWorker(input)
  })
  const runVerification = dependencies.runVerification ?? runVerificationCommand
  validateTimeout(taskTimeoutMs, 'taskTimeoutMs')
  validateTimeout(verificationTimeoutMs, 'verificationTimeoutMs')

  const runner: DevelopmentTaskRunner = async (opportunity) => {
    const taskKey = computeTaskKey(opportunity.id)
    let devRoot = options.devRoot

    function fail(failureReason: FailureReason, extra: Record<string, unknown> = {}) {
      const execution: DevelopmentExecution = {
        status: 'failed',
        evidence: { taskKey, devRoot, outcome: 'failed', failureReason, worktrees: [], ...extra }
      }

      return execution
    }

    let task: string

    try {
      task = validateOpportunity(opportunity)
    } catch (error) {
      return fail('invalid_task', { failureDetail: describeError(error) })
    }

    const devRootReal = await resolveDevRoot(options.devRoot)

    if (devRootReal === undefined) {
      return fail('dev_root_missing', { failureDetail: `${options.devRoot} is not a directory` })
    }

    devRoot = devRootReal
    let stateDir: string

    try {
      stateDir = await createTaskState(options.dataDir, taskKey)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('task_state_already_exists')) {
        return fail('task_state_already_exists', { failureDetail: describeError(error) })
      }

      throw error
    }

    let agent: AgentOutcome

    try {
      const result = await runAgent({
        devRoot,
        stateDir,
        taskKey,
        agentDir,
        title: opportunity.title,
        task,
        timeoutMs: taskTimeoutMs,
        env: options.env
      })
      agent = { status: 'completed', summary: result.summary.slice(0, MAX_SUMMARY_CHARS) }
    } catch (error) {
      if (isTerminationUnconfirmed(error)) {
        // 終了を確認できない worker が worktree を変更し続けるかもしれないため、差分も検証も扱わない
        return fail('termination_unconfirmed', { agentError: 'termination_unconfirmed', terminationConfirmed: false })
      }

      const code = getErrorCode(error)
      const workerErrorName = getStringProperty(error, 'workerErrorName')
      const workerErrorMessage = getStringProperty(error, 'workerErrorMessage')
      agent = {
        status: code === 'agent_timeout' ? 'timeout' : 'failed',
        error: code,
        ...(workerErrorName === undefined ? {} : { workerErrorName }),
        ...(workerErrorMessage === undefined ? {} : { workerErrorMessage })
      }
    }

    let state: Awaited<ReturnType<typeof readTaskState>>

    try {
      state = await readTaskState({ devRoot, stateDir, taskKey })
    } catch (error) {
      return fail('task_state_invalid', { ...agentEvidence(agent), failureDetail: describeError(error) })
    }

    const diffs: DiffEvidence[] = []

    try {
      const git = { executable: dependencies.gitExecutable ?? await findGitExecutable(), env: createGitEnv(options.env) }
      let diffBudget = MAX_DIFF_BYTES

      for (const record of state.worktrees) {
        const diff = await collectWorktreeDiff(git, record, diffBudget)
        diffBudget = Math.max(0, diffBudget - Buffer.byteLength(diff.diff))
        diffs.push(diff)
      }
    } catch (error) {
      // 差分の収集に使う git の終了を確認できない場合も、差分の収集の失敗として扱う
      return fail('evidence_collection_failed', {
        ...agentEvidence(agent),
        failureDetail: describeError(error),
        worktrees: state.worktrees.map(toWorktreeLocation)
      })
    }

    const changed = state.worktrees.map((_record, index) => {
      return (diffs[index]?.changedFiles.length ?? 0) > 0
    })
    const anyChanged = changed.includes(true)
    let verificationUnconfirmed = false
    const worktrees = []

    for (const [index, record] of state.worktrees.entries()) {
      const diff = diffs[index]

      if (diff === undefined) {
        continue
      }

      const registered = state.verifications.filter((verification) => {
        return verification.repository === record.repository
      })
      const verifications: VerificationEvidence[] = []

      for (const verification of registered) {
        if (agent.status !== 'completed') {
          verifications.push(notRun(verification, agent.status === 'timeout' ? 'agent_timeout' : 'agent_failed'))
          continue
        }

        if (changed[index] !== true) {
          verifications.push(notRun(verification, 'no_changes'))
          continue
        }

        if (verificationUnconfirmed) {
          verifications.push(notRun(verification, 'previous_termination_unconfirmed'))
          continue
        }

        const cwd = path.join(record.worktreePath, verification.cwd)
        const cwdProblem = await checkVerificationCwd(cwd, record.worktreePath)

        if (cwdProblem !== undefined) {
          verifications.push({ ...notRun(verification, cwdProblem), status: 'failed' })
          continue
        }

        let result: VerificationCommandResult

        try {
          result = await runVerification({
            command: verification.command,
            cwd,
            env: options.env,
            timeoutMs: verificationTimeoutMs
          })
        } catch (error) {
          verifications.push({ ...notRun(verification, 'verification_error'), status: 'failed', stderr: describeError(error) })
          continue
        }

        if (!result.terminationConfirmed) {
          verificationUnconfirmed = true
        }

        verifications.push({
          command: [...verification.command],
          cwd: verification.cwd,
          status: result.status,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
          ...(result.reason === undefined ? {} : { reason: result.reason })
        })
      }

      worktrees.push(toWorktreeEvidence(record, diff, verifications))
    }

    const failureReason: FailureReason | undefined = verificationUnconfirmed
      ? 'termination_unconfirmed'
      : agent.status === 'timeout'
        ? 'agent_timeout'
        : agent.status === 'failed'
          ? 'agent_failed'
          : !anyChanged
            ? 'no_changes'
            : worktrees.some((worktree, index) => {
              return changed[index] === true && worktree.verifications.length === 0
            })
              ? 'verification_missing'
              : worktrees.some((worktree) => {
                return worktree.verifications.some((verification) => {
                  return verification.status !== 'passed' && verification.status !== 'not_run'
                })
              })
                ? 'verification_failed'
                : undefined

    if (failureReason !== undefined) {
      return fail(failureReason, {
        ...agentEvidence(agent),
        worktrees,
        ...(verificationUnconfirmed ? { terminationConfirmed: false } : {})
      })
    }

    const execution: DevelopmentExecution = {
      status: 'completed',
      evidence: { taskKey, devRoot, outcome: 'completed', ...agentEvidence(agent), worktrees }
    }

    return execution
  }

  return runner
}
