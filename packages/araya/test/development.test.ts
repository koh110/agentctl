import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { Opportunity } from '../src/control-plane.ts'
import { createDevelopmentExecutor } from '../src/development.ts'
import type { DevelopmentModel, SessionModel } from '../src/development-model.ts'
import type { PiWorkerInput, VerificationCommandInput, VerificationCommandResult } from '../src/development-process.ts'
import { computeTaskKey, createWorktreeService } from '../src/development-worktrees.ts'

const OPPORTUNITY_ID = 'development:executor-test'
const TASK_KEY = computeTaskKey(OPPORTUNITY_ID)
const PASS_COMMAND = [process.execPath, '-e', "console.log('verified')"]
const FAIL_COMMAND = [process.execPath, '-e', "console.error('broken'); process.exit(1)"]
const SESSION_MODEL = { provider: 'openai', id: 'gpt-5.5', thinkingLevel: 'medium' } as const

type Fixture = Awaited<ReturnType<typeof createFixture>>

async function createFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-development-test-')))
  const home = path.join(root, 'home')
  const gitConfig = path.join(home, 'gitconfig')
  const devRoot = path.join(root, 'dev')
  const dataDir = path.join(root, 'data')
  await fs.mkdir(home)
  await fs.mkdir(devRoot)
  await fs.writeFile(gitConfig, '', 'utf8')
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Araya Test',
    GIT_AUTHOR_EMAIL: 'araya-test@example.invalid',
    GIT_COMMITTER_NAME: 'Araya Test',
    GIT_COMMITTER_EMAIL: 'araya-test@example.invalid'
  }

  return { root, devRoot, dataDir, env }
}

async function removeFixture(fixture: Fixture) {
  await fs.rm(fixture.root, { recursive: true, force: true })
}

function git(fixture: Fixture, cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    env: fixture.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function createRepository(fixture: Fixture, name: string) {
  const repositoryPath = path.join(fixture.devRoot, name)
  await fs.mkdir(repositoryPath)
  git(fixture, repositoryPath, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# fixture\n', 'utf8')
  git(fixture, repositoryPath, 'add', '--all')
  git(fixture, repositoryPath, 'commit', '-q', '-m', 'initial fixture')

  return repositoryPath
}

function createOpportunity(payload: Record<string, unknown> = { task: 'README を更新する' }, overrides: Partial<Opportunity> = {}) {
  const opportunity: Opportunity = {
    id: OPPORTUNITY_ID,
    observationId: OPPORTUNITY_ID,
    title: '開発課題',
    kind: 'development',
    risk: 'workspace',
    status: 'scouting',
    payload,
    attemptCount: 0,
    discoveredAt: 1,
    updatedAt: 1,
    ...overrides
  }

  return opportunity
}

function createExecutor(
  fixture: Fixture,
  runAgent: (input: PiWorkerInput) => Promise<{ summary: string; model: SessionModel }>,
  options: {
    devRoot?: string
    developmentModel?: DevelopmentModel | null
    verificationTimeoutMs?: number
    runVerification?: (input: VerificationCommandInput) => Promise<VerificationCommandResult>
    gitExecutable?: string
  } = {}
) {
  return createDevelopmentExecutor({
    devRoot: options.devRoot ?? fixture.devRoot,
    dataDir: fixture.dataDir,
    env: fixture.env,
    agentDir: path.join(fixture.root, 'pi-agent'),
    taskTimeoutMs: 5000,
    verificationTimeoutMs: options.verificationTimeoutMs ?? 10_000,
    ...(options.developmentModel === undefined ? {} : { developmentModel: options.developmentModel })
  }, {
    runAgent,
    ...(options.runVerification === undefined ? {} : { runVerification: options.runVerification }),
    ...(options.gitExecutable === undefined ? {} : { gitExecutable: options.gitExecutable })
  })
}

function serviceFor(input: PiWorkerInput) {
  return createWorktreeService({
    devRoot: input.devRoot,
    stateDir: input.stateDir,
    taskKey: input.taskKey,
    env: input.env
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecords(value: unknown, name: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} is not an array`)
  }

  const records: Record<string, unknown>[] = []

  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error(`${name} contains a non-object`)
    }

    records.push(item)
  }

  return records
}

function readWorktrees(evidence: Record<string, unknown>) {
  return readRecords(evidence.worktrees, 'worktrees')
}

function findWorktree(evidence: Record<string, unknown>, repository: string) {
  const worktree = readWorktrees(evidence).find((candidate) => {
    return candidate.repository === repository
  })

  if (worktree === undefined) {
    throw new Error(`no evidence for ${repository}`)
  }

  return worktree
}

function readVerifications(worktree: Record<string, unknown>) {
  return readRecords(worktree.verifications, 'verifications')
}

function worktreePathOf(repositoryPath: string) {
  return path.join(repositoryPath, '.worktree', `araya-${TASK_KEY}`)
}

async function exists(target: string) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

async function assertWorktreeKept(fixture: Fixture, repositoryPath: string) {
  assert.equal(git(fixture, repositoryPath, 'rev-parse', '--verify', '--quiet', `refs/heads/araya/${TASK_KEY}`).length > 0, true)
  assert.equal(git(fixture, repositoryPath, 'worktree', 'list', '--porcelain').includes(worktreePathOf(repositoryPath)), true)
}

// worktree を作り、README を書き換えて、検証を登録する偽の agent の手順
async function changeRepository(input: PiWorkerInput, repository: string, options: { command?: string[]; cwd?: string } = {}) {
  const service = serviceFor(input)
  const record = await service.createWorktree({ repository })
  await fs.appendFile(path.join(record.worktreePath, 'README.md'), `${repository} changed\n`, 'utf8')

  if (options.command !== undefined) {
    await service.registerVerification({
      repository,
      command: options.command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd })
    })
  }

  return record
}

test('executor: 2つの repository にまたがる課題が completed になり、差分と検証結果を残す', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const repoB = await createRepository(fixture, 'repo-b')
  const baseA = git(fixture, repoA, 'rev-parse', 'HEAD')
  const agentInputs: PiWorkerInput[] = []

  try {
    const execute = createExecutor(fixture, async (input) => {
      agentInputs.push(input)
      const service = serviceFor(input)
      const a = await service.createWorktree({ repository: 'repo-a' })
      const b = await service.createWorktree({ repository: 'repo-b', base: 'main' })
      await fs.writeFile(path.join(a.worktreePath, 'README.md'), '# fixture revised\n', 'utf8')
      await fs.mkdir(path.join(b.worktreePath, 'sub'))
      await fs.writeFile(path.join(b.worktreePath, 'sub', 'feature.txt'), 'feature\n', 'utf8')
      await service.registerVerification({
        repository: 'repo-a',
        command: [process.execPath, '-e', "process.exit(require('node:fs').readFileSync('README.md', 'utf8').includes('revised') ? 0 : 1)"]
      })
      await service.registerVerification({
        repository: 'repo-b',
        command: [process.execPath, '-e', "console.log(require('node:fs').readFileSync('feature.txt', 'utf8').trim())"],
        cwd: 'sub'
      })

      return { summary: 'repo-a と repo-b を変更しました。', model: SESSION_MODEL }
    })
    const result = await execute(createOpportunity())

    assert.equal(result.status, 'completed')
    assert.equal(result.evidence.outcome, 'completed')
    assert.equal(result.evidence.taskKey, TASK_KEY)
    assert.equal(result.evidence.devRoot, fixture.devRoot)
    assert.equal(result.evidence.summary, 'repo-a と repo-b を変更しました。')
    assert.equal('failureReason' in result.evidence, false)
    assert.deepEqual(agentInputs.map((input) => {
      return { ...input, env: undefined }
    }), [{
      devRoot: fixture.devRoot,
      stateDir: path.join(fixture.dataDir, 'development', TASK_KEY),
      taskKey: TASK_KEY,
      agentDir: path.join(fixture.root, 'pi-agent'),
      title: '開発課題',
      task: 'README を更新する',
      timeoutMs: 5000,
      model: null,
      env: undefined
    }])
    assert.deepEqual(result.evidence.model, { ...SESSION_MODEL, source: 'pi-settings' })
    assert.equal(agentInputs[0]?.env, fixture.env)

    const a = findWorktree(result.evidence, 'repo-a')
    assert.equal(a.worktreePath, worktreePathOf(repoA))
    assert.equal(a.branch, `araya/${TASK_KEY}`)
    assert.equal(a.base, 'HEAD')
    assert.equal(a.baseSha, baseA)
    assert.equal(a.headSha, baseA)
    assert.equal(a.headMoved, false)
    assert.equal(a.excludeAdded, true)
    assert.deepEqual(a.changedFiles, ['README.md'])
    assert.deepEqual(a.diffStat, { files: 1, insertions: 1, deletions: 1, truncated: false })
    assert.match(String(a.diff), /\+# fixture revised/u)
    assert.equal(a.diffTruncated, false)
    assert.deepEqual(readVerifications(a).map(({ status, exitCode, cwd }) => {
      return { status, exitCode, cwd }
    }), [{ status: 'passed', exitCode: 0, cwd: '' }])

    const b = findWorktree(result.evidence, 'repo-b')
    assert.equal(b.base, 'main')
    assert.deepEqual(b.changedFiles, ['sub/feature.txt'])
    assert.match(String(b.diff), /\+feature/u)
    const [verificationB] = readVerifications(b)
    assert.equal(verificationB?.status, 'passed')
    assert.equal(verificationB?.cwd, 'sub')
    assert.equal(verificationB?.stdout, 'feature\n')
    assert.equal(verificationB?.stderr, '')
    assert.equal(verificationB?.signal, null)

    // main checkout は変わらない
    assert.equal(git(fixture, repoA, 'status', '--porcelain'), '')
    assert.equal(await fs.readFile(path.join(repoA, 'README.md'), 'utf8'), '# fixture\n')
    await assertWorktreeKept(fixture, repoA)
    await assertWorktreeKept(fixture, repoB)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: 差分が無ければ no_changes で、検証は not_run', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const marker = path.join(fixture.root, 'verification-ran')

  try {
    const execute = createExecutor(fixture, async (input) => {
      const service = serviceFor(input)
      await service.createWorktree({ repository: 'repo-a' })
      await service.registerVerification({
        repository: 'repo-a',
        command: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker]
      })

      return { summary: '変更はありません。', model: SESSION_MODEL }
    })
    const result = await execute(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'no_changes')
    assert.equal(result.evidence.summary, '変更はありません。')
    const worktree = findWorktree(result.evidence, 'repo-a')
    assert.deepEqual(worktree.changedFiles, [])
    assert.deepEqual(readVerifications(worktree).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'not_run', reason: 'no_changes' }])
    assert.equal(await exists(marker), false)
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: worktree を作らなかった課題は no_changes', async () => {
  const fixture = await createFixture()

  try {
    const result = await createExecutor(fixture, async () => {
      return { summary: '何もしませんでした。', model: SESSION_MODEL }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'no_changes')
    assert.deepEqual(result.evidence.worktrees, [])
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: 検証の無い worktree があれば verification_missing だが、ほかの検証は実行する', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const repoB = await createRepository(fixture, 'repo-b')

  try {
    const result = await createExecutor(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await changeRepository(input, 'repo-b')
      return { summary: '変更しました。', model: SESSION_MODEL }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_missing')
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-a')).map(({ status, stdout }) => {
      return { status, stdout }
    }), [{ status: 'passed', stdout: 'verified\n' }])
    assert.deepEqual(findWorktree(result.evidence, 'repo-b').verifications, [])
    await assertWorktreeKept(fixture, repoA)
    await assertWorktreeKept(fixture, repoB)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: exit 1 の検証は verification_failed', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')

  try {
    const result = await createExecutor(fixture, async (input) => {
      const service = serviceFor(input)
      await changeRepository(input, 'repo-a', { command: FAIL_COMMAND })
      await service.registerVerification({ repository: 'repo-a', command: PASS_COMMAND })
      return { summary: '変更しました。', model: SESSION_MODEL }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_failed')
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-a')).map(({ status, exitCode, stderr }) => {
      return { status, exitCode, stderr }
    }), [
      { status: 'failed', exitCode: 1, stderr: 'broken\n' },
      { status: 'passed', exitCode: 0, stderr: '' }
    ])
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: timeout した検証は verification_failed', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')

  try {
    const result = await createExecutor(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] })
      return { summary: '変更しました。', model: SESSION_MODEL }
    }, { verificationTimeoutMs: 1000 })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_failed')
    assert.equal(readVerifications(findWorktree(result.evidence, 'repo-a'))[0]?.status, 'timeout')
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: cwd が無い検証は失敗として扱う', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')

  try {
    const result = await createExecutor(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND, cwd: 'missing/dir' })
      return { summary: '変更しました。', model: SESSION_MODEL }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_failed')
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-a')).map(({ status, reason, cwd }) => {
      return { status, reason, cwd }
    }), [{ status: 'failed', reason: 'cwd_missing', cwd: 'missing/dir' }])
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: agent の失敗では差分を集め、検証は not_run にする', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const marker = path.join(fixture.root, 'verification-ran')

  try {
    const result = await createExecutor(fixture, async (input) => {
      await changeRepository(input, 'repo-a', {
        command: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker]
      })
      throw Object.assign(new Error('Pi development worker failed'), {
        code: 'pi_worker_failed',
        terminationConfirmed: true,
        workerErrorName: 'Error',
        workerErrorMessage: 'model request failed'
      })
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'agent_failed')
    assert.equal(result.evidence.agentError, 'pi_worker_failed')
    assert.equal(result.evidence.workerErrorName, 'Error')
    assert.equal(result.evidence.workerErrorMessage, 'model request failed')
    assert.equal('summary' in result.evidence, false)
    assert.equal('model' in result.evidence, false)
    const worktree = findWorktree(result.evidence, 'repo-a')
    assert.deepEqual(worktree.changedFiles, ['README.md'])
    assert.match(String(worktree.diff), /\+repo-a changed/u)
    assert.deepEqual(readVerifications(worktree).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'not_run', reason: 'agent_failed' }])
    assert.equal(await exists(marker), false)
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: 設定ファイルで指定した model を worker に渡し、evidence に source araya-config で記録する', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  const developmentModel = { provider: 'openrouter', id: 'moonshotai/kimi-k2.6', thinkingLevel: 'high' } as const
  const reportedModel = { provider: 'openrouter', id: 'moonshotai/kimi-k2.6', thinkingLevel: 'high' } as const
  const models: (DevelopmentModel | null)[] = []

  try {
    const result = await createExecutor(fixture, async (input) => {
      models.push(input.model)
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      return { summary: '変更しました。', model: reportedModel }
    }, { developmentModel })(createOpportunity())

    assert.equal(result.status, 'completed')
    assert.deepEqual(models, [developmentModel])
    assert.deepEqual(result.evidence.model, { ...reportedModel, source: 'araya-config' })
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: model が決まった後の worker の失敗では、worker が報告した model を evidence に記録する', async () => {
  const fixture = await createFixture()

  try {
    const result = await createExecutor(fixture, async () => {
      throw Object.assign(new Error('Pi development worker failed'), {
        code: 'pi_worker_failed',
        terminationConfirmed: true,
        workerErrorName: 'Error',
        workerErrorMessage: 'Pi session ended with a model error: overloaded',
        workerModel: { provider: 'openai', id: 'gpt-5.5', thinkingLevel: 'xhigh' }
      })
    }, { developmentModel: { provider: 'openai', id: 'gpt-5.5', thinkingLevel: null } })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'agent_failed')
    assert.deepEqual(result.evidence.model, { provider: 'openai', id: 'gpt-5.5', thinkingLevel: 'xhigh', source: 'araya-config' })
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: 指定した model が使えなければ agent_failed で、ModelUnavailableError を記録し、model は記録しない', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')

  try {
    const result = await createExecutor(fixture, async () => {
      throw Object.assign(new Error('Pi development worker failed'), {
        code: 'pi_worker_failed',
        terminationConfirmed: true,
        workerErrorName: 'ModelUnavailableError',
        workerErrorMessage: 'configured model openai/gpt-araya-missing is not in the Pi model list'
      })
    }, { developmentModel: { provider: 'openai', id: 'gpt-araya-missing', thinkingLevel: 'high' } })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'agent_failed')
    assert.equal(result.evidence.workerErrorName, 'ModelUnavailableError')
    assert.match(String(result.evidence.workerErrorMessage), /openai\/gpt-araya-missing/u)
    assert.equal('model' in result.evidence, false)
    assert.deepEqual(result.evidence.worktrees, [])
    assert.equal(await exists(worktreePathOf(repoA)), false)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: agent の timeout は agent_timeout で、差分は残す', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')

  try {
    const result = await createExecutor(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      throw Object.assign(new Error('Pi worker timed out'), { code: 'agent_timeout', terminationConfirmed: true })
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'agent_timeout')
    assert.equal(result.evidence.agentError, 'agent_timeout')
    assert.equal('model' in result.evidence, false)
    const worktree = findWorktree(result.evidence, 'repo-a')
    assert.deepEqual(worktree.changedFiles, ['README.md'])
    assert.deepEqual(readVerifications(worktree).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'not_run', reason: 'agent_timeout' }])
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: worker の終了を確認できなければ差分も検証も扱わない', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const verificationCalls: VerificationCommandInput[] = []

  try {
    const result = await createExecutor(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      throw Object.assign(new Error('Pi worker process termination could not be confirmed'), {
        code: 'termination_unconfirmed',
        terminationConfirmed: false
      })
    }, {
      runVerification: async (input) => {
        verificationCalls.push(input)
        return runPassed()
      }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'termination_unconfirmed')
    assert.equal(result.evidence.terminationConfirmed, false)
    assert.deepEqual(result.evidence.worktrees, [])
    assert.equal(verificationCalls.length, 0)
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: 状態 directory が既にあれば agent を動かさない', async () => {
  const fixture = await createFixture()
  const stateDir = path.join(fixture.dataDir, 'development', TASK_KEY)
  await fs.mkdir(stateDir, { recursive: true })
  let agentCalled = false

  try {
    const result = await createExecutor(fixture, async () => {
      agentCalled = true
      return { summary: 'unexpected', model: SESSION_MODEL }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'task_state_already_exists')
    assert.equal(agentCalled, false)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: 不正な課題は invalid_task で、状態 directory も作らない', async () => {
  const fixture = await createFixture()
  let agentCalled = false
  const cases = [
    createOpportunity({ task: 'README を更新する', verifyCommand: ['npm', 'test'] }),
    createOpportunity({ task: '   ' }),
    createOpportunity({ task: 'a\0b' }),
    createOpportunity({ task: 'x'.repeat(20_001) }),
    createOpportunity({}),
    createOpportunity({ task: 'README を更新する' }, { kind: 'investigate' }),
    createOpportunity({ task: 'README を更新する' }, { risk: 'external' })
  ]

  try {
    const execute = createExecutor(fixture, async () => {
      agentCalled = true
      return { summary: 'unexpected', model: SESSION_MODEL }
    })

    for (const opportunity of cases) {
      const result = await execute(opportunity)

      assert.equal(result.status, 'failed')
      assert.equal(result.evidence.failureReason, 'invalid_task')
    }

    assert.match(String((await execute(cases[0] ?? createOpportunity())).evidence.failureDetail), /verifyCommand/u)
    assert.equal(agentCalled, false)
    assert.equal(await exists(path.join(fixture.dataDir, 'development')), false)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: 開発 root が directory でなければ dev_root_missing', async () => {
  const fixture = await createFixture()
  const file = path.join(fixture.root, 'not-a-directory')
  await fs.writeFile(file, '', 'utf8')
  let agentCalled = false

  try {
    for (const devRoot of [path.join(fixture.root, 'missing'), file]) {
      const result = await createExecutor(fixture, async () => {
        agentCalled = true
        return { summary: 'unexpected', model: SESSION_MODEL }
      }, { devRoot })(createOpportunity())

      assert.equal(result.status, 'failed')
      assert.equal(result.evidence.failureReason, 'dev_root_missing')
    }

    assert.equal(agentCalled, false)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: symlink の開発 root は解決先を使う', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  const link = path.join(fixture.root, 'dev-link')
  await fs.symlink(fixture.devRoot, link)
  const devRoots: string[] = []

  try {
    const result = await createExecutor(fixture, async (input) => {
      devRoots.push(input.devRoot)
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      return { summary: '変更しました。', model: SESSION_MODEL }
    }, { devRoot: link })(createOpportunity())

    assert.equal(result.status, 'completed')
    assert.deepEqual(devRoots, [fixture.devRoot])
    assert.equal(result.evidence.devRoot, fixture.devRoot)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: 記録 file が壊れていれば task_state_invalid で、検証を実行しない', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const verificationCalls: VerificationCommandInput[] = []

  try {
    const result = await createExecutor(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await fs.appendFile(path.join(input.stateDir, 'worktrees.jsonl'), '{broken\n', 'utf8')
      return { summary: '変更しました。', model: SESSION_MODEL }
    }, {
      runVerification: async (input) => {
        verificationCalls.push(input)
        return runPassed()
      }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'task_state_invalid')
    assert.equal(result.evidence.summary, '変更しました。')
    assert.match(String(result.evidence.failureDetail), /worktrees\.jsonl line 2/u)
    assert.deepEqual(result.evidence.worktrees, [])
    assert.equal(verificationCalls.length, 0)
    await assertWorktreeKept(fixture, repoA)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: worktree が消えていれば evidence_collection_failed', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const verificationCalls: VerificationCommandInput[] = []

  try {
    const result = await createExecutor(fixture, async (input) => {
      const record = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await fs.rm(record.worktreePath, { recursive: true, force: true })
      return { summary: '変更しました。', model: SESSION_MODEL }
    }, {
      runVerification: async (input) => {
        verificationCalls.push(input)
        return runPassed()
      }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'evidence_collection_failed')
    assert.deepEqual(readWorktrees(result.evidence).map(({ repository, worktreePath }) => {
      return { repository, worktreePath }
    }), [{ repository: 'repo-a', worktreePath: worktreePathOf(repoA) }])
    assert.equal(verificationCalls.length, 0)
    assert.equal(git(fixture, repoA, 'rev-parse', '--verify', '--quiet', `refs/heads/araya/${TASK_KEY}`).length > 0, true)
  } finally {
    await removeFixture(fixture)
  }
})

function runPassed() {
  const result: VerificationCommandResult = {
    status: 'passed',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    terminationConfirmed: true
  }

  return result
}

test('executor: worktree の path が symlink で別の場所を指していれば task_state_invalid で、差分も検証も扱わない', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  // 開発 root の外にある別の repository
  const outside = path.join(fixture.root, 'outside')
  await fs.mkdir(outside)
  git(fixture, outside, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(outside, 'README.md'), '# outside\n', 'utf8')
  git(fixture, outside, 'add', '--all')
  git(fixture, outside, 'commit', '-q', '-m', 'outside fixture')
  const verificationCalls: VerificationCommandInput[] = []

  try {
    const result = await createExecutor(fixture, async (input) => {
      const record = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await fs.rm(record.worktreePath, { recursive: true, force: true })
      await fs.symlink(outside, record.worktreePath)
      return { summary: '変更しました。', model: SESSION_MODEL }
    }, {
      runVerification: async (input) => {
        verificationCalls.push(input)
        return runPassed()
      }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'task_state_invalid')
    assert.match(String(result.evidence.failureDetail), /symlinks/u)
    assert.deepEqual(result.evidence.worktrees, [])
    assert.equal(verificationCalls.length, 0)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: 記録した path が壊れた symlink や symlink の下にあれば task_state_invalid で、差分も検証も扱わない', async () => {
  const cases = [
    {
      name: 'worktree が壊れた symlink',
      tamper: async (worktreePath: string, fixture: Fixture) => {
        await fs.rm(worktreePath, { recursive: true, force: true })
        await fs.symlink(path.join(fixture.root, 'missing-target'), worktreePath)
      }
    },
    {
      name: '.worktree が別の場所への symlink',
      tamper: async (worktreePath: string, fixture: Fixture) => {
        const empty = path.join(fixture.root, 'empty')
        await fs.mkdir(empty)
        await fs.rm(path.dirname(worktreePath), { recursive: true, force: true })
        await fs.symlink(empty, path.dirname(worktreePath))
      }
    }
  ]

  for (const { name, tamper } of cases) {
    const fixture = await createFixture()
    await createRepository(fixture, 'repo-a')
    const verificationCalls: VerificationCommandInput[] = []

    try {
      const result = await createExecutor(fixture, async (input) => {
        const record = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
        await tamper(record.worktreePath, fixture)
        return { summary: '変更しました。', model: SESSION_MODEL }
      }, {
        runVerification: async (input) => {
          verificationCalls.push(input)
          return runPassed()
        }
      })(createOpportunity())

      assert.equal(result.status, 'failed', name)
      assert.equal(result.evidence.failureReason, 'task_state_invalid', name)
      assert.match(String(result.evidence.failureDetail), /is not a real directory/u, name)
      assert.deepEqual(result.evidence.worktrees, [], name)
      assert.equal(verificationCalls.length, 0, name)
    } finally {
      await removeFixture(fixture)
    }
  }
})

test('executor: 差分の収集に使う git の終了を確認できなければ evidence_collection_failed', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  const holderPidFile = path.join(fixture.root, 'holder.pid')
  const fakeGitScript = path.join(fixture.root, 'fake-git.cjs')
  const fakeGit = path.join(fixture.root, 'fake-git')
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { env: fixture.env, encoding: 'utf8' }).trim()
  // 差分の本体を出す git diff（--binary）だけ、別 session の子 process に stdout を開いたまま残させ、親が kill されても pipe が閉じないようにする
  await fs.writeFile(fakeGitScript, [
    "const { spawn, spawnSync } = require('node:child_process')",
    "const fs = require('node:fs')",
    'const args = process.argv.slice(2)',
    "if (!args.includes('--binary')) {",
    `  const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })`,
    '  process.exit(result.status ?? 1)',
    '}',
    "const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] })",
    `fs.writeFileSync(${JSON.stringify(holderPidFile)}, String(holder.pid))`,
    'holder.unref()',
    "process.stdout.write('x'.repeat(1024 * 1024))",
    'setInterval(() => {}, 1000)'
  ].join('\n'), 'utf8')
  await fs.writeFile(fakeGit, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGitScript)} "$@"\n`, { encoding: 'utf8', mode: 0o755 })
  const verificationCalls: VerificationCommandInput[] = []

  try {
    const result = await createExecutor(fixture, async (input) => {
      await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      return { summary: '変更しました。', model: SESSION_MODEL }
    }, {
      gitExecutable: fakeGit,
      runVerification: async (input) => {
        verificationCalls.push(input)
        return runPassed()
      }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'evidence_collection_failed')
    assert.match(String(result.evidence.failureDetail), /termination could not be confirmed/u)
    assert.equal(verificationCalls.length, 0)
  } finally {
    const holderPid = Number(await fs.readFile(holderPidFile, 'utf8').catch(() => {
      return ''
    }))

    if (Number.isInteger(holderPid) && holderPid > 0) {
      try {
        process.kill(holderPid, 'SIGKILL')
      } catch {
        // 既に終了している
      }
    }

    await removeFixture(fixture)
  }
})

test('executor: 検証の cwd が symlink で worktree の外を指していれば、その検証は実行せず失敗にする', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  const outside = path.join(fixture.root, 'outside-cwd')
  await fs.mkdir(outside)
  const verificationCalls: VerificationCommandInput[] = []

  try {
    const result = await createExecutor(fixture, async (input) => {
      const record = await changeRepository(input, 'repo-a', { command: PASS_COMMAND, cwd: 'linked' })
      await fs.symlink(outside, path.join(record.worktreePath, 'linked'))
      return { summary: '変更しました。', model: SESSION_MODEL }
    }, {
      runVerification: async (input) => {
        verificationCalls.push(input)
        return runPassed()
      }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'verification_failed')
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-a')).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'failed', reason: 'cwd_outside_worktree' }])
    assert.equal(verificationCalls.length, 0)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: 検証の終了を確認できなければ残りの検証を実行しない', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  await createRepository(fixture, 'repo-b')
  const verificationCalls: string[] = []

  try {
    const result = await createExecutor(fixture, async (input) => {
      const service = serviceFor(input)
      await changeRepository(input, 'repo-a', { command: ['first'] })
      await service.registerVerification({ repository: 'repo-a', command: ['second'] })
      await changeRepository(input, 'repo-b', { command: ['third'] })
      return { summary: '変更しました。', model: SESSION_MODEL }
    }, {
      runVerification: async (input) => {
        verificationCalls.push(input.command.join(' '))
        return input.command[0] === 'first'
          ? { ...runPassed(), status: 'timeout', exitCode: null, signal: 'SIGKILL', terminationConfirmed: false, reason: 'termination_unconfirmed' }
          : runPassed()
      }
    })(createOpportunity())

    assert.equal(result.status, 'failed')
    assert.equal(result.evidence.failureReason, 'termination_unconfirmed')
    assert.equal(result.evidence.terminationConfirmed, false)
    assert.deepEqual(verificationCalls, ['first'])
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-a')).map(({ status, reason }) => {
      return { status, reason }
    }), [
      { status: 'timeout', reason: 'termination_unconfirmed' },
      { status: 'not_run', reason: 'previous_termination_unconfirmed' }
    ])
    assert.deepEqual(readVerifications(findWorktree(result.evidence, 'repo-b')).map(({ status, reason }) => {
      return { status, reason }
    }), [{ status: 'not_run', reason: 'previous_termination_unconfirmed' }])
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: agent が commit すると headMoved を記録し、commit 済みの差分も含める', async () => {
  const fixture = await createFixture()
  const repoA = await createRepository(fixture, 'repo-a')
  const baseSha = git(fixture, repoA, 'rev-parse', 'HEAD')

  try {
    const result = await createExecutor(fixture, async (input) => {
      const record = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await fs.writeFile(path.join(record.worktreePath, 'committed.txt'), 'committed\n', 'utf8')
      git(fixture, record.worktreePath, 'add', 'committed.txt')
      git(fixture, record.worktreePath, 'commit', '-q', '-m', 'agent commit')
      return { summary: '変更しました。', model: SESSION_MODEL }
    })(createOpportunity())

    assert.equal(result.status, 'completed')
    const worktree = findWorktree(result.evidence, 'repo-a')
    assert.equal(worktree.baseSha, baseSha)
    assert.equal(worktree.headMoved, true)
    assert.notEqual(worktree.headSha, baseSha)
    assert.equal(worktree.headSha, git(fixture, worktreePathOf(repoA), 'rev-parse', 'HEAD'))
    assert.deepEqual(worktree.changedFiles, ['README.md', 'committed.txt'])
    assert.match(String(worktree.diff), /\+committed/u)
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: diff は全 worktree の合計で上限を超えると diffTruncated になる', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')
  await createRepository(fixture, 'repo-b')

  try {
    const result = await createExecutor(fixture, async (input) => {
      const a = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      await fs.writeFile(path.join(a.worktreePath, 'README.md'), `${'large line\n'.repeat(30_000)}`, 'utf8')
      await changeRepository(input, 'repo-b', { command: PASS_COMMAND })
      return { summary: '変更しました。', model: SESSION_MODEL }
    })(createOpportunity())

    assert.equal(result.status, 'completed')
    const a = findWorktree(result.evidence, 'repo-a')
    const b = findWorktree(result.evidence, 'repo-b')
    const totalBytes = Buffer.byteLength(String(a.diff)) + Buffer.byteLength(String(b.diff))

    assert.equal(a.diffTruncated, true)
    assert.equal(b.diffTruncated, true)
    assert.deepEqual(b.changedFiles, ['README.md'])
    assert.ok(totalBytes <= 256 * 1024)
    assert.match(String(a.diff), /\[diff truncated: the evidence limit is 262144 bytes across all worktrees\]\n$/u)
    // 上限を使い切った後の worktree は、印も入らないため diff を残さない
    assert.equal(b.diff, '')
    assert.equal(readVerifications(b)[0]?.status, 'passed')
  } finally {
    await removeFixture(fixture)
  }
})

test('executor: untracked の分で上限を超えても、切り詰めの印を含めて上限に収める', async () => {
  const fixture = await createFixture()
  await createRepository(fixture, 'repo-a')

  try {
    const result = await createExecutor(fixture, async (input) => {
      const a = await changeRepository(input, 'repo-a', { command: PASS_COMMAND })
      // tracked の diff は上限の少し手前に収め、untracked の file で上限を超えさせる
      await fs.writeFile(path.join(a.worktreePath, 'README.md'), `${'large line\n'.repeat(21_000)}`, 'utf8')
      await fs.writeFile(path.join(a.worktreePath, 'extra.txt'), `${'extra line\n'.repeat(2000)}`, 'utf8')
      return { summary: '変更しました。', model: SESSION_MODEL }
    })(createOpportunity())

    assert.equal(result.status, 'completed')
    const a = findWorktree(result.evidence, 'repo-a')

    assert.deepEqual(a.changedFiles, ['README.md', 'extra.txt'])
    assert.equal(a.diffTruncated, true)
    assert.ok(Buffer.byteLength(String(a.diff)) <= 256 * 1024)
    assert.match(String(a.diff), /\[diff truncated: the evidence limit is 262144 bytes across all worktrees\]\n$/u)
  } finally {
    await removeFixture(fixture)
  }
})
