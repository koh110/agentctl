import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { openControlPlane } from '../src/control-plane.ts'
import { createDevelopmentExecutor, runSandboxedVerification } from '../src/development.ts'
import { createWorkspaceFileOperations, createWorkspaceTools } from '../src/development-tools.ts'
import { runSandboxedPiAgent } from '../src/development-sandbox.ts'

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'araya-development-test-'))
}

function runGit(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function readChangedFiles(evidence: Record<string, unknown>) {
  if (!isStringArray(evidence.changedFiles)) {
    throw new Error('changedFiles evidence is not a string array')
  }

  return evidence.changedFiles
}

function readVerifyExitCode(evidence: Record<string, unknown>) {
  const verify = evidence.verify

  if (typeof verify !== 'object' || verify === null || !('exitCode' in verify) || typeof verify.exitCode !== 'number') {
    throw new Error('verify evidence has no numeric exitCode')
  }

  return verify.exitCode
}

async function createGitRepository(root: string) {
  const projectDir = path.join(root, 'source')
  await fs.mkdir(projectDir, { recursive: true })
  runGit(projectDir, 'init', '-b', 'main')
  runGit(projectDir, 'config', 'user.name', 'Araya Test')
  runGit(projectDir, 'config', 'user.email', 'araya-test@example.invalid')
  await fs.writeFile(path.join(projectDir, 'README.md'), '# fixture\n', 'utf8')
  runGit(projectDir, 'add', '--all')
  runGit(projectDir, 'commit', '-m', 'initial fixture')

  return projectDir
}

function createDevelopmentOpportunity(controlPlanePath: string) {
  const controlPlane = openControlPlane(controlPlanePath)
  controlPlane.ensureGoal('goal:development-test', 'development task', 1000, 1)
  controlPlane.recordObservationBatch([{
    observationId: 'development:task-test',
    kind: 'development',
    title: 'Add a fixture file',
    risk: 'workspace',
    payload: { task: 'Create src/feature.ts', verifyCommand: ['node', '--version'] }
  }], 'goal:development-test', 2)
  const opportunity = controlPlane.getOpportunity('development:task-test')

  if (opportunity === undefined) {
    controlPlane.close()
    throw new Error('development opportunity was not recorded')
  }

  return { controlPlane, opportunity }
}

test('development executor creates a dedicated worktree and preserves uncommitted diff evidence', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim()
  const worktreeDir = path.join(root, 'worktrees')
  const { controlPlane, opportunity } = createDevelopmentOpportunity(path.join(root, 'control-plane.sqlite'))
  const agentCalls: string[] = []

  try {
    const execute = createDevelopmentExecutor({
      projectDir,
      worktreeDir,
      taskTimeoutMs: 5000,
      verificationTimeoutMs: 5000
    }, {
      runAgent: async ({ cwd, task }) => {
        agentCalls.push(task)
        await fs.writeFile(path.join(cwd, 'README.md'), '# fixture revised\n', 'utf8')
        await fs.mkdir(path.join(cwd, 'src'), { recursive: true })
        await fs.writeFile(path.join(cwd, 'src', 'feature.ts'), 'export const value = 1\n', 'utf8')

        return { summary: 'Created the feature file.' }
      },
      runVerification: async ({ command }) => ({
        command: [...command],
        exitCode: 0,
        stdout: 'verification passed',
        stderr: ''
      })
    })

    const result = await execute(opportunity)

    assert.equal(result.status, 'completed')
    assert.equal(agentCalls.length, 1)
    assert.deepEqual(agentCalls, ['Create src/feature.ts'])
    assert.equal(result.evidence.baseSha, baseHead)
    assert.equal(readChangedFiles(result.evidence).includes('src/feature.ts'), true)
    assert.equal(readChangedFiles(result.evidence).includes('README.md'), true)
    assert.match(String(result.evidence.diff), /export const value = 1/u)
    assert.deepEqual(result.evidence.diffStat, { files: 2, insertions: 2, deletions: 1, truncated: false })
    assert.equal(readVerifyExitCode(result.evidence), 0)
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim(), baseHead)
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' }).trim(), '')
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: String(result.evidence.worktreePath),
      encoding: 'utf8'
    }).trim(), baseHead)
    assert.equal(await fs.readFile(path.join(String(result.evidence.worktreePath), 'src', 'feature.ts'), 'utf8'), 'export const value = 1\n')
  } finally {
    controlPlane.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development executor does not collect evidence from a pre-existing worktree path', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const worktreeDir = path.join(root, 'worktrees')
  const { controlPlane, opportunity } = createDevelopmentOpportunity(path.join(root, 'control-plane.sqlite'))
  const suffix = createHash('sha256').update(opportunity.id).digest('hex').slice(0, 20)
  const branch = `araya/development-${suffix}`
  const worktreePath = path.join(worktreeDir, `development-${suffix}`)
  await fs.mkdir(worktreeDir, { mode: 0o700 })

  try {
    runGit(projectDir, 'worktree', 'add', '-b', branch, worktreePath, 'HEAD')
    await fs.writeFile(path.join(worktreePath, 'README.md'), '# stale unrelated worktree\n', 'utf8')
    let agentCalled = false
    const execute = createDevelopmentExecutor({ projectDir, worktreeDir }, {
      runAgent: async () => {
        agentCalled = true
        return { summary: 'unexpected' }
      }
    })

    const result = await execute(opportunity)

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.error, 'worktree_path_already_exists')
    assert.deepEqual(result.evidence.verify, {
      command: ['node', '--version'],
      status: 'not_run',
      reason: 'execution_failed_before_verification'
    })
    assert.equal(agentCalled, false)
    assert.equal('changedFiles' in result.evidence, false)
    assert.equal('diff' in result.evidence, false)
    assert.equal('diffStat' in result.evidence, false)
    assert.equal(await fs.readFile(path.join(worktreePath, 'README.md'), 'utf8'), '# stale unrelated worktree\n')
    assert.equal(await fs.readFile(path.join(projectDir, 'README.md'), 'utf8'), '# fixture\n')
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' }).trim(), '')
  } finally {
    controlPlane.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development executor fails a no-op agent response even when verification passes', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const { controlPlane, opportunity } = createDevelopmentOpportunity(path.join(root, 'control-plane.sqlite'))

  try {
    const execute = createDevelopmentExecutor({
      projectDir,
      worktreeDir: path.join(root, 'worktrees')
    }, {
      runAgent: async () => ({ summary: 'No files changed.' }),
      runVerification: async ({ command }) => ({
        command: [...command],
        exitCode: 0,
        stdout: 'verification passed',
        stderr: ''
      })
    })

    const result = await execute(opportunity)

    assert.equal(result.status, 'failed')
    assert.deepEqual(readChangedFiles(result.evidence), [])
    assert.equal(readVerifyExitCode(result.evidence), 0)
    assert.equal(typeof result.evidence.worktreePath, 'string')
  } finally {
    controlPlane.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development executor records a not-run verification command when the agent fails', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const { controlPlane, opportunity } = createDevelopmentOpportunity(path.join(root, 'control-plane.sqlite'))
  let verificationCalled = false

  try {
    const execute = createDevelopmentExecutor({
      projectDir,
      worktreeDir: path.join(root, 'worktrees')
    }, {
      runAgent: async () => {
        throw new Error('provider_unavailable')
      },
      runVerification: async ({ command }) => {
        verificationCalled = true
        return { command: [...command], exitCode: 0, stdout: '', stderr: '' }
      }
    })

    const result = await execute(opportunity)

    assert.equal(result.status, 'failed')
    assert.equal(verificationCalled, false)
    assert.deepEqual(result.evidence.verify, {
      command: ['node', '--version'],
      status: 'not_run',
      reason: 'agent_failed'
    })
  } finally {
    controlPlane.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development executor keeps evidence untouched when process termination is unconfirmed', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const { controlPlane, opportunity } = createDevelopmentOpportunity(path.join(root, 'control-plane.sqlite'))
  let verificationCalled = false

  try {
    const execute = createDevelopmentExecutor({
      projectDir,
      worktreeDir: path.join(root, 'worktrees')
    }, {
      runAgent: async () => {
        throw Object.assign(new Error('termination unconfirmed'), { terminationConfirmed: false })
      },
      runVerification: async ({ command }) => {
        verificationCalled = true
        return { command: [...command], exitCode: 0, stdout: '', stderr: '' }
      }
    })

    const result = await execute(opportunity)

    assert.equal(result.status, 'failed')
    assert.equal(verificationCalled, false)
    assert.equal(result.evidence.terminationConfirmed, false)
    assert.deepEqual(result.evidence.verify, {
      command: ['node', '--version'],
      status: 'not_run',
      reason: 'agent_termination_unconfirmed'
    })
    assert.equal('changedFiles' in result.evidence, false)
    assert.equal('diff' in result.evidence, false)
    assert.equal('diffStat' in result.evidence, false)
  } finally {
    controlPlane.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development executor refuses a dirty source repository before creating a worktree', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const worktreeDir = path.join(root, 'worktrees')
  const { controlPlane, opportunity } = createDevelopmentOpportunity(path.join(root, 'control-plane.sqlite'))
  let agentCalled = false

  try {
    await fs.writeFile(path.join(projectDir, 'uncommitted.txt'), 'preserve me\n', 'utf8')
    const execute = createDevelopmentExecutor({ projectDir, worktreeDir }, {
      runAgent: async () => {
        agentCalled = true
        return { summary: 'unexpected' }
      }
    })

    const result = await execute(opportunity)

    assert.equal(result.status, 'failed')
    assert.equal(agentCalled, false)
    assert.equal(await fs.readdir(worktreeDir).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return []
      }

      throw error
    }).then((entries) => entries.length), 0)
    assert.equal(await fs.readFile(path.join(projectDir, 'uncommitted.txt'), 'utf8'), 'preserve me\n')
  } finally {
    controlPlane.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development executor rejects a symlinked worktree parent before creating anything in the source repository', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const projectAlias = path.join(root, 'project-alias')
  const worktreeDir = path.join(projectAlias, 'worktrees')
  const { controlPlane, opportunity } = createDevelopmentOpportunity(path.join(root, 'control-plane.sqlite'))
  await fs.symlink(projectDir, projectAlias)

  try {
    const execute = createDevelopmentExecutor({ projectDir, worktreeDir }, {
      runAgent: async () => ({ summary: 'should not run' })
    })
    const result = await execute(opportunity)

    assert.equal(result.status, 'failed')
    await assert.rejects(fs.lstat(path.join(projectDir, 'worktrees')), { code: 'ENOENT' })
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: projectDir, encoding: 'utf8' }).trim(), '')
  } finally {
    controlPlane.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development executor refuses a worktree directory that other users can read', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const worktreeDir = path.join(root, 'shared-worktrees')
  const { controlPlane, opportunity } = createDevelopmentOpportunity(path.join(root, 'control-plane.sqlite'))
  let agentCalled = false
  await fs.mkdir(worktreeDir, { mode: 0o755 })
  await fs.chmod(worktreeDir, 0o755)

  try {
    const execute = createDevelopmentExecutor({ projectDir, worktreeDir }, {
      runAgent: async () => {
        agentCalled = true
        return { summary: 'unexpected' }
      }
    })
    const result = await execute(opportunity)

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.error, 'worktree_root_permissions_unsafe')
    assert.equal(agentCalled, false)
    assert.equal((await fs.readdir(worktreeDir)).length, 0)
  } finally {
    controlPlane.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development executor retains the worktree and diff when verification fails', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const { controlPlane, opportunity } = createDevelopmentOpportunity(path.join(root, 'control-plane.sqlite'))

  try {
    const execute = createDevelopmentExecutor({
      projectDir,
      worktreeDir: path.join(root, 'worktrees')
    }, {
      runAgent: async ({ cwd }) => {
        await fs.writeFile(path.join(cwd, 'attempt.txt'), 'review me\n', 'utf8')
        return { summary: 'Attempted the change.' }
      },
      runVerification: async ({ command }) => ({
        command: [...command],
        exitCode: 1,
        stdout: 'test failed',
        stderr: ''
      })
    })

    const result = await execute(opportunity)

    assert.equal(result.status, 'failed')
    assert.equal(readVerifyExitCode(result.evidence), 1)
    assert.equal(readChangedFiles(result.evidence).includes('attempt.txt'), true)
    assert.equal(await fs.readFile(path.join(String(result.evidence.worktreePath), 'attempt.txt'), 'utf8'), 'review me\n')
  } finally {
    controlPlane.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('workspace file operations reject traversal, sensitive paths, symlink escapes, and hardlinks', async () => {
  const root = await makeTempDir()
  const workspace = path.join(root, 'workspace')
  const outside = path.join(root, 'outside.txt')
  await fs.mkdir(workspace)
  await fs.writeFile(outside, 'keep secret', 'utf8')
  await fs.writeFile(path.join(workspace, 'safe.txt'), 'safe content', 'utf8')
  await fs.symlink(outside, path.join(workspace, 'escape.txt'))
  await fs.link(outside, path.join(workspace, 'hardlink.txt'))
  const operations = await createWorkspaceFileOperations(workspace)

  try {
    assert.equal(await operations.readTextFile('safe.txt'), 'safe content')
    await assert.rejects(operations.readTextFile('../outside.txt'), /cannot contain \.\./u)
    await assert.rejects(operations.writeFile('missing/../safe.txt', 'changed'), /cannot contain \.\./u)
    await assert.rejects(operations.writeFile(path.join(root, 'outside.txt'), 'changed'), /outside the development workspace/u)
    await assert.rejects(operations.readTextFile('escape.txt'), /symbolic link/u)
    await assert.rejects(operations.writeFile('hardlink.txt', 'changed'), /hard link/u)
    await assert.rejects(operations.readFile('.git/config'), /reserved path/u)
    await assert.rejects(operations.writeFile('.env', 'TOKEN=hidden'), /sensitive path/u)
    assert.equal(await fs.readFile(path.join(workspace, 'safe.txt'), 'utf8'), 'safe content')
    assert.equal(await fs.readFile(outside, 'utf8'), 'keep secret')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

function invokeWorkspaceTool(
  tool: Awaited<ReturnType<typeof createWorkspaceTools>>[number],
  params: object
) {
  return Reflect.apply(tool.execute, tool, ['workspace-path-test', params, undefined, undefined, undefined])
}

test('Pi workspace tools reject literal parent path components before SDK normalization', async () => {
  const root = await makeTempDir()
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'safe.txt'), 'safe content\n', 'utf8')

  try {
    const [read, write, edit, ls, find, grep] = await createWorkspaceTools(workspace)
    const calls = [
      { tool: read, params: { path: 'missing/../safe.txt' } },
      { tool: write, params: { path: 'missing/../safe.txt', content: 'changed' } },
      { tool: edit, params: { path: 'missing/../safe.txt', edits: [{ oldText: 'safe', newText: 'changed' }] } },
      { tool: ls, params: { path: 'missing/..' } },
      { tool: find, params: { path: 'missing/..', pattern: '**/*' } },
      { tool: grep, params: { path: 'missing/../safe.txt', pattern: 'safe', literal: true } }
    ]

    for (const call of calls) {
      await assert.rejects(
        invokeWorkspaceTool(call.tool, call.params),
        /workspace path cannot contain \.\./u
      )
    }

    assert.equal(await fs.readFile(path.join(workspace, 'safe.txt'), 'utf8'), 'safe content\n')
    assert.deepEqual(await fs.readdir(workspace), ['safe.txt'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('sandboxed verification hides host files, secrets, and network behind an isolated HOME', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const worktreePath = path.join(root, 'worktree')
  const hostFile = path.join(root, 'outside.txt')
  const server = createServer((socket) => socket.end('host service reached'))
  await fs.mkdir(worktreePath)
  await fs.writeFile(hostFile, 'preserve me', 'utf8')
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()

  if (address === null || typeof address === 'string') {
    throw new Error('test listener did not receive a TCP address')
  }

  const probe = `void (async () => { const fs = require('node:fs'); const net = require('node:net'); const target = ${JSON.stringify(hostFile)}; let blocked = false; try { fs.writeFileSync(target, 'overwritten') } catch { blocked = true }; const reachable = await new Promise((resolve) => { const socket = net.connect({ host: '127.0.0.1', port: ${address.port} }); const timer = setTimeout(() => { socket.destroy(); resolve(false) }, 1000); socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) }); socket.once('error', () => { clearTimeout(timer); resolve(false) }) }); process.stdout.write(JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, blocked, hostShadowVisible: fs.existsSync('/etc/shadow'), hostNetworkReachable: reachable })) })()`

  try {
    const result = await runSandboxedVerification(projectDir, worktreePath, ['node', '-e', probe], 10000)

    assert.equal(result.exitCode, 0)
    assert.deepEqual(JSON.parse(result.stdout), {
      cwd: '/workspace',
      home: '/tmp/home',
      blocked: true,
      hostShadowVisible: false,
      hostNetworkReachable: false
    })
    assert.equal(await fs.readFile(hostFile, 'utf8'), 'preserve me')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('sandboxed verification hides a linked worktree git pointer after applying its temporary overlay', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const worktreePath = path.join(root, 'worktree')
  runGit(projectDir, 'remote', 'add', 'origin', 'https://user:DO_NOT_EXPOSE@example.invalid/repo.git')
  runGit(projectDir, 'worktree', 'add', '-b', 'verification-metadata-test', worktreePath, 'HEAD')
  const gitPointer = await fs.readFile(path.join(worktreePath, '.git'), 'utf8')

  try {
    assert.match(gitPointer, /^gitdir:/u)
    const result = await runSandboxedVerification(
      projectDir,
      worktreePath,
      ['node', '-e', "const fs = require('node:fs'); let visibility = 'visible'; try { fs.readFileSync('/workspace/.git', 'utf8') } catch (error) { visibility = ['EACCES', 'ENOENT', 'ENOTDIR'].includes(error.code) ? 'hidden' : 'unexpected-error' }; process.stdout.write(JSON.stringify({ visibility }))"],
      10000
    )

    assert.equal(result.exitCode, 0, JSON.stringify(result))
    assert.deepEqual(JSON.parse(result.stdout), { visibility: 'hidden' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('sandboxed verification reads project dependencies read-only without creating worktree files', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const worktreePath = path.join(root, 'worktree')
  const dependencyDir = path.join(projectDir, 'node_modules', 'fixture-dependency')
  await fs.mkdir(worktreePath)
  await fs.mkdir(dependencyDir, { recursive: true })
  await fs.writeFile(path.join(dependencyDir, 'value.txt'), 'dependency data', 'utf8')
  const probe = `const fs = require('node:fs'); const dependency = '/workspace/node_modules/fixture-dependency/value.txt'; let blocked = false; try { fs.writeFileSync(dependency, 'modified') } catch { blocked = true }; fs.writeFileSync('/workspace/generated.txt', 'ephemeral'); process.stdout.write(JSON.stringify({ dependency: fs.readFileSync(dependency, 'utf8'), blocked }))`

  try {
    const result = await runSandboxedVerification(projectDir, worktreePath, ['node', '-e', probe], 10000)

    assert.equal(result.exitCode, 0, JSON.stringify(result))
    assert.deepEqual(JSON.parse(result.stdout), { dependency: 'dependency data', blocked: true })
    assert.equal(await fs.readFile(path.join(dependencyDir, 'value.txt'), 'utf8'), 'dependency data')
    await assert.rejects(fs.lstat(path.join(worktreePath, 'node_modules')), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(path.join(worktreePath, 'generated.txt')), { code: 'ENOENT' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('sandboxed verification rejects a dependency root symlink that points outside the project', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const worktreePath = path.join(root, 'worktree')
  const externalDependencies = path.join(root, 'external-dependencies')
  await fs.mkdir(worktreePath)
  await fs.mkdir(externalDependencies)
  await fs.writeFile(path.join(externalDependencies, 'fixture.txt'), 'external dependency fixture', 'utf8')
  await fs.symlink(externalDependencies, path.join(projectDir, 'node_modules'))

  try {
    await assert.rejects(
      runSandboxedVerification(
        projectDir,
        worktreePath,
        ['node', '-e', "process.stdout.write(require('node:fs').readFileSync('/workspace/node_modules/fixture.txt', 'utf8'))"],
        10000
      ),
      /project node_modules must be a real directory/u
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('sandboxed verification rejects dependency hardlinks that also name files outside the project', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const worktreePath = path.join(root, 'worktree')
  const dependencyDir = path.join(projectDir, 'node_modules')
  const externalFile = path.join(root, 'external-credential-fixture')
  await fs.mkdir(worktreePath)
  await fs.mkdir(dependencyDir)
  await fs.writeFile(externalFile, 'external dependency hardlink fixture', 'utf8')
  await fs.link(externalFile, path.join(dependencyDir, 'linked-file'))

  try {
    await assert.rejects(
      runSandboxedVerification(
        projectDir,
        worktreePath,
        ['node', '-e', "process.stdout.write(require('node:fs').readFileSync('/workspace/node_modules/linked-file', 'utf8'))"],
        10000
      ),
      /project dependency tree contains an external hardlink/u
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('sandboxed Pi worker rejects a dependency root symlink before reading host packages', async () => {
  const root = await makeTempDir()
  const projectRoot = path.join(root, 'project')
  const packageRoot = path.join(projectRoot, 'packages', 'araya')
  const sourceDirectory = path.join(packageRoot, 'src')
  const binDirectory = path.join(packageRoot, 'bin')
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const hostNodeModules = path.resolve(testDirectory, '../../..', 'node_modules')
  const workspacePath = path.join(root, 'worktree')
  const agentDir = path.join(root, 'empty-pi-agent')
  await fs.mkdir(sourceDirectory, { recursive: true })
  await fs.mkdir(binDirectory, { recursive: true })
  await fs.mkdir(workspacePath)
  await fs.mkdir(agentDir)
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  await fs.writeFile(path.join(workspacePath, '.git'), 'gitdir: ../.git/worktrees/test\n', 'utf8')

  for (const sourceName of ['development-sandbox.ts', 'development-agent.ts', 'development-tools.ts']) {
    await fs.copyFile(
      path.join(testDirectory, '../src', sourceName),
      path.join(sourceDirectory, sourceName)
    )
  }

  await fs.copyFile(
    path.join(testDirectory, '../bin/development-worker.ts'),
    path.join(binDirectory, 'development-worker.ts')
  )
  await fs.symlink(hostNodeModules, path.join(projectRoot, 'node_modules'), 'dir')
  const sandboxModule = await import(pathToFileURL(path.join(sourceDirectory, 'development-sandbox.ts')).href)

  try {
    await assert.rejects(sandboxModule.runSandboxedPiAgent({
      workspacePath,
      agentDir,
      title: 'Do not make a model request',
      task: 'No model is configured in this isolated test.',
      timeoutMs: 5000
    }), /Pi SDK node_modules must be a real directory/u)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('sandboxed Pi worker starts without exposing the host Pi configuration', async () => {
  const root = await makeTempDir()
  const projectDir = await createGitRepository(root)
  const workspacePath = path.join(root, 'sandbox-worktree')
  runGit(projectDir, 'worktree', 'add', '--detach', workspacePath, 'HEAD')
  const agentDir = path.join(root, 'empty-pi-agent')
  await fs.mkdir(agentDir)

  try {
    await assert.rejects(runSandboxedPiAgent({
      workspacePath,
      agentDir,
      title: 'Do not make a model request',
      task: 'No model is configured in this isolated test.',
      timeoutMs: 10000
    }), /Pi development worker failed/u)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
