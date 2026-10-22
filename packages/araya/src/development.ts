import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import type { Opportunity } from './control-plane.ts'
import { runBoundedCommand, runSandboxedPiAgent, runSandboxedVerification } from './development-sandbox.ts'

export { runSandboxedVerification }

const MAX_TASK_TIMEOUT_MS = 60 * 60 * 1000
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_CHANGED_FILES = 1000
const MAX_CHANGED_PATH_BYTES = 128 * 1024
const MAX_DIFF_BYTES = 256 * 1024
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024
const GIT_CANDIDATES = ['/usr/bin/git', '/bin/git', '/usr/local/bin/git'] as const
const SAFE_GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  HOME: '/tmp',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  TMPDIR: '/tmp'
} as const

export type DevelopmentExecution = {
  status: 'completed' | 'failed'
  evidence: Record<string, unknown>
}

export type DevelopmentTaskRunner = (opportunity: Opportunity) => Promise<DevelopmentExecution>

export type DevelopmentExecutorOptions = {
  projectDir: string
  worktreeDir: string
  agentDir?: string
  taskTimeoutMs?: number
  verificationTimeoutMs?: number
}

type DevelopmentAgentInput = {
  cwd: string
  agentDir: string
  title: string
  task: string
  timeoutMs: number
}

type VerificationInput = {
  projectDir: string
  workspacePath: string
  command: readonly string[]
  timeoutMs: number
}

type DevelopmentExecutorDependencies = {
  runAgent?: (input: DevelopmentAgentInput) => Promise<{ summary: string }>
  runVerification?: (input: VerificationInput) => Promise<{
    command: string[]
    exitCode: number
    stdout: string
    stderr: string
    timedOut?: boolean
    signal?: string | null
    terminationConfirmed?: boolean
    error?: string
  }>
}

type GitResult = {
  stdout: string
  stderr: string
}

type ChangedFile = {
  path: string
  status: string
}

function isWithinOrEqual(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate)

  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function pathsOverlap(left: string, right: string) {
  return isWithinOrEqual(left, right) || isWithinOrEqual(right, left)
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

  if (error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)) {
    return error.message
  }

  return 'development_executor_failed'
}

function validateTimeout(timeoutMs: number, name: string) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TASK_TIMEOUT_MS) {
    throw new Error(`${name} must be between 1000 and ${MAX_TASK_TIMEOUT_MS} milliseconds`)
  }
}

function validateOpportunity(opportunity: Opportunity) {
  if (opportunity.kind !== 'development' || opportunity.risk !== 'workspace') {
    throw new Error('invalid_development_scope')
  }

  const task = opportunity.payload.task
  const verifyCommand = opportunity.payload.verifyCommand

  if (typeof task !== 'string' || task.trim() === '' || task.length > 20_000 || task.includes('\0')) {
    throw new Error('invalid_development_task')
  }

  if (
    !Array.isArray(verifyCommand) ||
    verifyCommand.length === 0 ||
    verifyCommand.length > 64 ||
    verifyCommand.some((argument) =>
      typeof argument !== 'string' || argument.trim() === '' || argument.length > 4096 || argument.includes('\0')
    )
  ) {
    throw new Error('invalid_development_verify_command')
  }

  const commandSize = verifyCommand.reduce((total, argument) => {
    return total + (typeof argument === 'string' ? argument.length : 0)
  }, 0)

  if (commandSize > 32_768) {
    throw new Error('invalid_development_verify_command')
  }

  return { task, verifyCommand: [...verifyCommand] }
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

  throw new Error('git_executable_unavailable')
}

async function runGit(
  gitExecutable: string,
  repositoryPath: string,
  args: readonly string[],
  options: { input?: string; acceptedExitCodes?: readonly number[] } = {}
): Promise<GitResult> {
  const result = await runBoundedCommand(gitExecutable, [
    '-C', repositoryPath,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.pager=cat',
    '-c', 'advice.detachedHead=false',
    ...args
  ], {
    env: { ...SAFE_GIT_ENV },
    ...(options.input === undefined ? {} : { input: options.input }),
    timeoutMs: 30_000,
    stdoutLimitBytes: MAX_GIT_OUTPUT_BYTES,
    stderrLimitBytes: 64 * 1024
  })

  if (result.terminationConfirmed === false) {
    throw Object.assign(new Error('git_termination_unconfirmed'), { terminationConfirmed: false })
  }

  if (
    result.terminationReason !== undefined ||
    result.exitCode === null ||
    !(options.acceptedExitCodes ?? [0]).includes(result.exitCode)
  ) {
    throw new Error('git_command_failed')
  }

  return { stdout: result.stdout, stderr: result.stderr }
}

function parseChangedFiles(output: string) {
  const entries = output.split('\0')
  const changedFiles: ChangedFile[] = []
  let pathBytes = 0

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]

    if (entry === undefined || entry === '') {
      continue
    }

    if (entry.length < 4 || entry[2] !== ' ') {
      throw new Error('git_status_output_invalid')
    }

    const status = entry.slice(0, 2)
    const filePath = entry.slice(3)

    if (
      filePath === '' ||
      filePath.length > 4096 ||
      path.isAbsolute(filePath) ||
      filePath.split(/[\\/]+/u).includes('..')
    ) {
      throw new Error('git_status_path_invalid')
    }

    pathBytes += Buffer.byteLength(filePath)

    if (pathBytes > MAX_CHANGED_PATH_BYTES) {
      throw new Error('changed_path_byte_limit_exceeded')
    }

    changedFiles.push({ path: filePath, status })

    if (status.includes('R') || status.includes('C')) {
      index += 1
    }

    if (changedFiles.length > MAX_CHANGED_FILES) {
      throw new Error('changed_file_limit_exceeded')
    }
  }

  return changedFiles
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

async function collectUntrackedDiff(worktreePath: string, changedFiles: readonly ChangedFile[]) {
  const chunks: string[] = []
  let bytes = 0
  let truncated = false

  for (const changedFile of changedFiles) {
    if (!changedFile.status.includes('?')) {
      continue
    }

    const candidate = path.resolve(worktreePath, changedFile.path)

    if (!isWithinOrEqual(candidate, worktreePath)) {
      throw new Error('untracked_path_outside_worktree')
    }

    let fileHandle

    try {
      fileHandle = await fs.open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    } catch (error) {
      if (isErrno(error, 'ELOOP')) {
        const note = `\n[untracked symlink omitted: ${JSON.stringify(changedFile.path)}]\n`
        chunks.push(note)
        bytes += Buffer.byteLength(note)
        continue
      }

      if (isErrno(error, 'ENOENT')) {
        throw new Error('untracked_file_changed_during_evidence_collection')
      }

      throw error
    }

    try {
      const openedStat = await fileHandle.stat()
      const namedStat = await fs.lstat(candidate)

      if (
        !openedStat.isFile() ||
        namedStat.isSymbolicLink() ||
        openedStat.dev !== namedStat.dev ||
        openedStat.ino !== namedStat.ino
      ) {
        throw new Error('untracked_file_identity_changed')
      }

      if (openedStat.nlink !== 1) {
        const note = `\n[untracked hard-linked file omitted: ${JSON.stringify(changedFile.path)}]\n`
        chunks.push(note)
        bytes += Buffer.byteLength(note)
        continue
      }

      const remaining = Math.max(0, MAX_UNTRACKED_FILE_BYTES - bytes)
      const fileRead = await readBoundedFile(fileHandle, Math.min(MAX_UNTRACKED_FILE_BYTES, remaining))
      const relativePath = changedFile.path.replaceAll('\\', '/')
      const displayedPath = JSON.stringify(relativePath)
      const header = [
        `diff --git a/${displayedPath} b/${displayedPath}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${displayedPath}`
      ]

      if (fileRead.truncated || openedStat.size > fileRead.content.byteLength) {
        const note = `\n[untracked file content omitted or truncated: ${displayedPath}; bytes=${openedStat.size}]\n`
        const chunk = `${header.join('\n')}\n${note}`
        chunks.push(chunk)
        bytes += Buffer.byteLength(chunk)
        truncated = true
        continue
      }

      let text: string

      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(fileRead.content)
      } catch {
        const note = `\n[binary untracked file omitted: ${displayedPath}; bytes=${openedStat.size}]\n`
        const chunk = `${header.join('\n')}\n${note}`
        chunks.push(chunk)
        bytes += Buffer.byteLength(chunk)
        continue
      }

      const lines = text.split('\n')

      if (text.endsWith('\n')) {
        lines.pop()
      }

      const hunk = lines.length === 0 ? [] : [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)]
      const chunk = `${header.join('\n')}\n${hunk.join('\n')}${hunk.length === 0 ? '' : '\n'}`
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

async function collectEvidence(worktreePath: string, gitExecutable: string) {
  const status = await runGit(gitExecutable, worktreePath, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'
  ])
  const changedFiles = parseChangedFiles(status.stdout)
  const trackedDiff = await runBoundedCommand(gitExecutable, [
    '-C', worktreePath,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', '--unified=3', '--'
  ], {
    env: { ...SAFE_GIT_ENV },
    timeoutMs: 30_000,
    stdoutLimitBytes: MAX_DIFF_BYTES,
    stderrLimitBytes: 64 * 1024
  })

  if (trackedDiff.terminationConfirmed === false) {
    throw Object.assign(new Error('git_diff_termination_unconfirmed'), { terminationConfirmed: false })
  }

  if (trackedDiff.exitCode === null || (
    trackedDiff.terminationReason !== undefined && trackedDiff.terminationReason !== 'output_overflow'
  )) {
    throw new Error('git_diff_failed')
  }

  const untracked = await collectUntrackedDiff(worktreePath, changedFiles)
  const diff = `${trackedDiff.stdout}${untracked.diff}`
  const limitedDiff = Buffer.byteLength(diff) > MAX_DIFF_BYTES
    ? `${truncateUtf8(diff, MAX_DIFF_BYTES)}\n[diff truncated at ${MAX_DIFF_BYTES} bytes]\n`
    : diff

  const diffTruncated = trackedDiff.terminationReason === 'output_overflow' || untracked.truncated || limitedDiff !== diff

  return {
    changedFiles: changedFiles.map(({ path: filePath }) => filePath),
    diff: limitedDiff,
    diffTruncated,
    diffStat: summarizeDiff(limitedDiff, changedFiles.length, diffTruncated)
  }
}

async function inspectRepository(projectDir: string, gitExecutable: string) {
  const projectRealPath = await fs.realpath(projectDir)
  const topLevelResult = await runGit(gitExecutable, projectRealPath, ['rev-parse', '--show-toplevel'])
  const topLevel = await fs.realpath(topLevelResult.stdout.trim())

  if (topLevel !== projectRealPath) {
    throw new Error('project_directory_must_be_repository_root')
  }

  const status = await runGit(gitExecutable, projectRealPath, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'
  ])

  if (status.stdout !== '') {
    throw new Error('source_repository_not_clean')
  }

  const files = await runGit(gitExecutable, projectRealPath, ['ls-files', '-z'])
  const attributes = await runGit(gitExecutable, projectRealPath, ['check-attr', '-z', '--all', '--stdin'], {
    input: files.stdout
  })
  const attributeFields = attributes.stdout.split('\0')

  for (let index = 0; index + 2 < attributeFields.length; index += 3) {
    const attributeName = attributeFields[index + 1]
    const attributeValue = attributeFields[index + 2]

    if (attributeName === 'filter' && attributeValue !== 'unspecified' && attributeValue !== 'unset') {
      throw new Error('custom_checkout_filter_not_allowed')
    }
  }

  const head = await runGit(gitExecutable, projectRealPath, ['rev-parse', '--verify', 'HEAD'])
  const baseSha = head.stdout.trim()

  if (!/^[0-9a-f]{40,64}$/u.test(baseSha)) {
    throw new Error('repository_head_invalid')
  }

  return { projectRealPath, baseSha }
}

async function validateWorktreePathAncestors(targetPath: string) {
  const parsed = path.parse(targetPath)
  let currentPath = parsed.root
  const components = path.relative(parsed.root, targetPath).split(path.sep).filter((component) => component !== '')

  for (const [index, component] of components.entries()) {
    currentPath = path.join(currentPath, component)
    let stat

    try {
      stat = await fs.lstat(currentPath)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return
      }

      throw error
    }

    if (stat.isSymbolicLink()) {
      throw new Error('worktree_root_path_contains_symlink')
    }

    if (!stat.isDirectory()) {
      throw new Error('worktree_root_parent_must_be_directory')
    }

    if (index < components.length - 1 && (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      throw new Error('worktree_root_parent_permissions_unsafe')
    }
  }
}

async function prepareWorktreeRoot(worktreeDir: string, projectRealPath: string) {
  const resolvedWorktreeDir = path.resolve(worktreeDir)

  if (pathsOverlap(resolvedWorktreeDir, projectRealPath)) {
    throw new Error('worktree_root_overlaps_project')
  }

  await validateWorktreePathAncestors(resolvedWorktreeDir)
  await fs.mkdir(resolvedWorktreeDir, { recursive: true, mode: 0o700 })
  await validateWorktreePathAncestors(resolvedWorktreeDir)
  const stat = await fs.lstat(resolvedWorktreeDir)

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('worktree_root_must_be_real_directory')
  }

  const realWorktreeDir = await fs.realpath(resolvedWorktreeDir)

  if (pathsOverlap(realWorktreeDir, projectRealPath)) {
    throw new Error('worktree_root_overlaps_project')
  }

  if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('worktree_root_permissions_unsafe')
  }

  return realWorktreeDir
}

async function runDefaultAgent(input: DevelopmentAgentInput) {
  return runSandboxedPiAgent({
    workspacePath: input.cwd,
    agentDir: input.agentDir,
    title: input.title,
    task: input.task,
    timeoutMs: input.timeoutMs
  })
}

async function runDefaultVerification(input: VerificationInput) {
  return runSandboxedVerification(input.projectDir, input.workspacePath, input.command, input.timeoutMs)
}

export function createDevelopmentExecutor(
  options: DevelopmentExecutorOptions,
  dependencies: DevelopmentExecutorDependencies = {}
): DevelopmentTaskRunner {
  const taskTimeoutMs = options.taskTimeoutMs ?? 20 * 60 * 1000
  const verificationTimeoutMs = options.verificationTimeoutMs ?? 5 * 60 * 1000
  validateTimeout(taskTimeoutMs, 'taskTimeoutMs')
  validateTimeout(verificationTimeoutMs, 'verificationTimeoutMs')

  return async (opportunity) => {
    let worktreePath: string | undefined
    let branch: string | undefined
    let baseSha: string | undefined
    let gitExecutable: string | undefined
    let worktreeCreated = false
    let verificationEvidence: Record<string, unknown> | undefined

    try {
      const { task, verifyCommand } = validateOpportunity(opportunity)
      verificationEvidence = {
        command: verifyCommand,
        status: 'not_run',
        reason: 'execution_failed_before_verification'
      }
      gitExecutable = await findGitExecutable()
      const repository = await inspectRepository(options.projectDir, gitExecutable)
      baseSha = repository.baseSha
      const realWorktreeDir = await prepareWorktreeRoot(options.worktreeDir, repository.projectRealPath)
      const suffix = createHash('sha256').update(opportunity.id).digest('hex').slice(0, 20)
      branch = `araya/development-${suffix}`
      worktreePath = path.join(realWorktreeDir, `development-${suffix}`)

      try {
        await fs.lstat(worktreePath)
        throw new Error('worktree_path_already_exists')
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) {
          throw error
        }
      }

      await runGit(gitExecutable, repository.projectRealPath, [
        'worktree', 'add', '-b', branch, worktreePath, baseSha
      ])
      worktreeCreated = true

      const agentDir = options.agentDir ?? path.join(os.homedir(), '.pi', 'agent')
      let agentResult: { status: 'completed'; summary: string } | { status: 'failed'; error: string }

      try {
        const result = await (dependencies.runAgent ?? runDefaultAgent)({
          cwd: worktreePath,
          agentDir,
          title: opportunity.title,
          task,
          timeoutMs: taskTimeoutMs
        })
        agentResult = { status: 'completed', summary: result.summary.slice(0, 4000) }
      } catch (error) {
        if (isTerminationUnconfirmed(error)) {
          verificationEvidence = {
            command: verifyCommand,
            status: 'not_run',
            reason: 'agent_termination_unconfirmed'
          }
          return {
            status: 'failed',
            evidence: {
              baseSha,
              worktreePath,
              branch,
              agentError: 'process_termination_unconfirmed',
              verify: verificationEvidence,
              terminationConfirmed: false
            }
          }
        }

        agentResult = { status: 'failed', error: getErrorCode(error) }
        verificationEvidence = {
          command: verifyCommand,
          status: 'not_run',
          reason: 'agent_failed'
        }
      }

      let verification: Awaited<ReturnType<typeof runDefaultVerification>> | undefined

      if (agentResult.status === 'completed') {
        verificationEvidence = { command: verifyCommand, status: 'running' }

        try {
          const verificationResult = await (dependencies.runVerification ?? runDefaultVerification)({
            projectDir: repository.projectRealPath,
            workspacePath: worktreePath,
            command: verifyCommand,
            timeoutMs: verificationTimeoutMs
          })
          verification = {
            ...verificationResult,
            terminationConfirmed: verificationResult.terminationConfirmed ?? true
          }
        } catch (error) {
          if (isTerminationUnconfirmed(error)) {
            verificationEvidence = { command: verifyCommand, status: 'termination_unconfirmed' }
            return {
              status: 'failed',
              evidence: {
                baseSha,
                worktreePath,
                branch,
                summary: agentResult.summary,
                verificationError: 'process_termination_unconfirmed',
                verify: verificationEvidence,
                terminationConfirmed: false
              }
            }
          }

          verification = {
            command: verifyCommand,
            exitCode: 1,
            stdout: '',
            stderr: '',
            terminationConfirmed: true,
            error: getErrorCode(error)
          }
        }
      }

      if (verification?.terminationConfirmed === false) {
        verificationEvidence = { command: verification.command, status: 'termination_unconfirmed' }
        return {
          status: 'failed',
          evidence: {
            baseSha,
            worktreePath,
            branch,
            ...(agentResult.status === 'completed' ? { summary: agentResult.summary } : { agentError: agentResult.error }),
            verificationError: 'process_termination_unconfirmed',
            verify: verificationEvidence,
            terminationConfirmed: false
          }
        }
      }

      const verificationPassed = verification !== undefined &&
        verification.exitCode === 0 &&
        verification.timedOut !== true &&
        verification.error === undefined
      if (verification !== undefined) {
        verificationEvidence = {
          command: verification.command,
          status: verificationPassed ? 'passed' : 'failed',
          exitCode: verification.exitCode,
          stdout: verification.stdout,
          stderr: verification.stderr,
          ...(verification.timedOut === undefined ? {} : { timedOut: verification.timedOut }),
          ...(verification.signal === undefined ? {} : { signal: verification.signal }),
          ...(verification.error === undefined ? {} : { error: verification.error })
        }
      }
      const diffEvidence = await collectEvidence(worktreePath, gitExecutable)
      const completed = agentResult.status === 'completed' &&
        verificationPassed &&
        diffEvidence.changedFiles.length > 0
      const evidence: Record<string, unknown> = {
        baseSha,
        worktreePath,
        branch,
        changedFiles: diffEvidence.changedFiles,
        diff: diffEvidence.diff,
        diffTruncated: diffEvidence.diffTruncated,
        diffStat: diffEvidence.diffStat,
        ...(!completed ? {
          failureReason: agentResult.status === 'failed'
            ? 'agent_failed'
            : verificationPassed
              ? 'no_workspace_changes'
              : 'verification_failed'
        } : {}),
        ...(agentResult.status === 'completed'
          ? { summary: agentResult.summary }
          : { agentError: agentResult.error }),
        ...(verificationEvidence === undefined ? {} : { verify: verificationEvidence })
      }

      return { status: completed ? 'completed' : 'failed', evidence }
    } catch (error) {
      const evidence: Record<string, unknown> = {
        error: getErrorCode(error),
        ...(baseSha === undefined ? {} : { baseSha }),
        ...(worktreePath === undefined ? {} : { worktreePath }),
        ...(branch === undefined ? {} : { branch }),
        ...(verificationEvidence === undefined ? {} : { verify: verificationEvidence })
      }

      if (isTerminationUnconfirmed(error)) {
        evidence.terminationConfirmed = false
      } else if (worktreeCreated && worktreePath !== undefined && gitExecutable !== undefined) {
        try {
          const diffEvidence = await collectEvidence(worktreePath, gitExecutable)
          evidence.changedFiles = diffEvidence.changedFiles
          evidence.diff = diffEvidence.diff
          evidence.diffTruncated = diffEvidence.diffTruncated
          evidence.diffStat = diffEvidence.diffStat
        } catch (evidenceError) {
          if (isTerminationUnconfirmed(evidenceError)) {
            evidence.evidenceCollectionError = 'process_termination_unconfirmed'
            evidence.terminationConfirmed = false
          } else {
            evidence.evidenceCollectionError = 'failed'
          }
        }
      }

      return { status: 'failed', evidence }
    }
  }
}
