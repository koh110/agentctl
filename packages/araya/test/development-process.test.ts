import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  parsePiWorkerResult,
  runBoundedCommand,
  runPiWorker,
  runVerificationCommand,
  type BoundedProcessResult
} from '../src/development-process.ts'
import { computeTaskKey } from '../src/development-worktrees.ts'

const TASK_KEY = computeTaskKey('development:process-test')
const SESSION_MODEL = { provider: 'openai', id: 'gpt-5.5', thinkingLevel: 'high' }

async function makeTempDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-development-process-test-')))
}

async function exists(target: string) {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

function hasCode(code: string) {
  return (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === code
  }
}

function makeResult(overrides: Partial<BoundedProcessResult> = {}) {
  const result: BoundedProcessResult = {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    terminationReason: undefined,
    terminationConfirmed: true,
    ...overrides
  }

  return result
}

// stdin の JSON を受け取り、body の script を実行する偽の worker を作る
async function writeFakeWorker(root: string, body: string) {
  const workerPath = path.join(root, `fake-worker-${Math.random().toString(16).slice(2)}.mjs`)
  await fs.writeFile(workerPath, [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    'const chunks = []',
    'for await (const chunk of process.stdin) chunks.push(chunk)',
    "const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))",
    body
  ].join('\n'), 'utf8')

  return workerPath
}

async function createWorkerInput(root: string) {
  const devRoot = path.join(root, 'dev')
  const stateDir = path.join(root, 'state')
  const agentDir = path.join(root, 'pi-agent')
  await fs.mkdir(devRoot, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
  await fs.mkdir(agentDir, { recursive: true })

  return {
    devRoot,
    stateDir,
    taskKey: TASK_KEY,
    agentDir,
    title: 'Fake worker',
    task: 'Do nothing.',
    timeoutMs: 1000,
    model: { provider: 'openai', id: 'gpt-5.5', thinkingLevel: null },
    env: { HOME: root, ARAYA_TEST_MARK: 'inherited' }
  }
}

test('runBoundedCommand: strict は上限を超えた出力で process を止める', async () => {
  const startedAt = Date.now()
  const result = await runBoundedCommand(process.execPath, [
    '-e',
    "process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000)"
  ], {
    timeoutMs: 10_000,
    stdout: { mode: 'strict', limitBytes: 100 }
  })

  assert.equal(result.terminationReason, 'output_overflow')
  assert.equal(result.terminationConfirmed, true)
  assert.equal(result.stdout, 'x'.repeat(100))
  assert.ok(Date.now() - startedAt < 5000)
})

test('runBoundedCommand: tail は止めずに末尾と総 byte 数を残し、不正な UTF-8 を置換する', async () => {
  const result = await runBoundedCommand(process.execPath, [
    '-e',
    "process.stdout.write('a'.repeat(10000) + 'END'); process.stdout.write(Buffer.from([0xff])); process.stderr.write('err')"
  ], {
    timeoutMs: 10_000,
    stdout: { mode: 'tail', limitBytes: 8 },
    stderr: { mode: 'tail', limitBytes: 8 }
  })

  assert.equal(result.terminationReason, undefined)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdoutBytes, 10004)
  assert.equal(result.stdout, 'aaaaEND�')
  assert.equal(result.stderr, 'err')
  assert.equal(result.stderrBytes, 3)
})

test('runBoundedCommand: strict は不正な UTF-8 で止める', async () => {
  const result = await runBoundedCommand(process.execPath, [
    '-e',
    'process.stderr.write(Buffer.from([0xff]))'
  ], {
    timeoutMs: 1000
  })

  assert.equal(result.terminationReason, 'invalid_utf8')
  assert.equal(result.terminationConfirmed, true)
})

test('runBoundedCommand: SIGTERM で終わる子は猶予内に終わる', async () => {
  const root = await makeTempDir()
  const marker = path.join(root, 'terminated')

  try {
    const startedAt = Date.now()
    const result = await runBoundedCommand(process.execPath, [
      '-e',
      "process.on('SIGTERM', () => { require('node:fs').writeFileSync(process.argv[1], 'yes'); process.exit(0) }); setInterval(() => {}, 1000)",
      marker
    ], {
      timeoutMs: 1000,
      terminationGraceMs: 10_000
    })

    assert.equal(result.terminationReason, 'timeout')
    assert.equal(result.terminationConfirmed, true)
    assert.equal(result.exitCode, 0)
    assert.equal(result.signal, null)
    assert.equal(await fs.readFile(marker, 'utf8'), 'yes')
    assert.ok(Date.now() - startedAt < 5000)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runBoundedCommand: SIGTERM を無視する子は猶予の後に SIGKILL される', async () => {
  const startedAt = Date.now()
  const result = await runBoundedCommand(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  ], {
    timeoutMs: 1000,
    terminationGraceMs: 500
  })

  assert.equal(result.terminationReason, 'timeout')
  assert.equal(result.terminationConfirmed, true)
  assert.equal(result.signal, 'SIGKILL')
  assert.ok(Date.now() - startedAt >= 1500)
})

test('runBoundedCommand: 起動できない実行 file は安定した code で失敗する', async () => {
  await assert.rejects(runBoundedCommand('/__araya_test__/missing-executable', [], {
    env: {},
    timeoutMs: 1000
  }), hasCode('subprocess_launch_failed'))
})

test('runVerificationCommand: exit 0 は passed で、出力を残す', async () => {
  const root = await makeTempDir()

  try {
    const result = await runVerificationCommand({
      command: [process.execPath, '-e', "console.log(process.cwd()); console.error('warn')"],
      cwd: root,
      env: { HOME: root },
      timeoutMs: 10_000
    })

    assert.equal(result.status, 'passed')
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, `${root}\n`)
    assert.equal(result.stderr, 'warn\n')
    assert.equal(result.terminationConfirmed, true)
    assert.equal(result.reason, undefined)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runVerificationCommand: 0 以外の exit code は failed', async () => {
  const root = await makeTempDir()

  try {
    const result = await runVerificationCommand({
      command: [process.execPath, '-e', 'process.exit(3)'],
      cwd: root,
      env: {},
      timeoutMs: 10_000
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.exitCode, 3)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runVerificationCommand: timeout は timeout になる', async () => {
  const root = await makeTempDir()

  try {
    const result = await runVerificationCommand({
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: root,
      env: {},
      timeoutMs: 1000
    })

    assert.equal(result.status, 'timeout')
    assert.equal(result.terminationConfirmed, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runVerificationCommand: 実行 file が無ければ launch_failed', async () => {
  const root = await makeTempDir()

  try {
    const result = await runVerificationCommand({
      command: ['araya-test-command-that-does-not-exist'],
      cwd: root,
      env: { PATH: root },
      timeoutMs: 1000
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'launch_failed')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runVerificationCommand: cwd が無ければ起動せずに cwd_missing', async () => {
  const root = await makeTempDir()
  const marker = path.join(root, 'started')

  try {
    const result = await runVerificationCommand({
      command: [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], '')", marker],
      cwd: path.join(root, 'missing'),
      env: {},
      timeoutMs: 1000
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.reason, 'cwd_missing')
    assert.equal(await exists(marker), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runPiWorker: 成功の応答から summary と model を返し、入力と環境を worker に渡す', async () => {
  const root = await makeTempDir()
  const input = await createWorkerInput(root)
  const workerPath = await writeFakeWorker(root, [
    "fs.writeFileSync(path.join(input.stateDir, 'received.json'), JSON.stringify({ input, cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, mark: process.env.ARAYA_TEST_MARK }))",
    `process.stdout.write(JSON.stringify({ status: 'completed', summary: 'まとめ', model: ${JSON.stringify(SESSION_MODEL)} }))`
  ].join('\n'))

  try {
    const result = await runPiWorker(input, { workerPath })
    const received: unknown = JSON.parse(await fs.readFile(path.join(input.stateDir, 'received.json'), 'utf8'))

    assert.deepEqual(result, { summary: 'まとめ', model: SESSION_MODEL })
    assert.deepEqual(received, {
      input: {
        agentDir: input.agentDir,
        devRoot: input.devRoot,
        model: { provider: 'openai', id: 'gpt-5.5', thinkingLevel: null },
        stateDir: input.stateDir,
        task: input.task,
        taskKey: input.taskKey,
        timeoutMs: input.timeoutMs,
        title: input.title
      },
      cwd: input.devRoot,
      agentDir: input.agentDir,
      mark: 'inherited'
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runPiWorker: failed の応答は pi_worker_failed と worker の error を返す', async () => {
  const root = await makeTempDir()
  const input = await createWorkerInput(root)
  const workerPath = await writeFakeWorker(root, [
    "process.stdout.write(JSON.stringify({ status: 'failed', errorName: 'Error', errorMessage: 'no configured Pi model is available', model: null }))",
    'process.exitCode = 1'
  ].join('\n'))

  try {
    await assert.rejects(runPiWorker(input, { workerPath }), (error: unknown) => {
      return error instanceof Error &&
        'code' in error && error.code === 'pi_worker_failed' &&
        'workerErrorName' in error && error.workerErrorName === 'Error' &&
        'workerErrorMessage' in error && error.workerErrorMessage === 'no configured Pi model is available' &&
        !('workerModel' in error)
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runPiWorker: model が決まった後の failed の応答は、worker が報告した model を返す', async () => {
  const root = await makeTempDir()
  const input = await createWorkerInput(root)
  const workerPath = await writeFakeWorker(root, [
    `process.stdout.write(JSON.stringify({ status: 'failed', errorName: 'Error', errorMessage: 'model request failed', model: ${JSON.stringify(SESSION_MODEL)} }))`,
    'process.exitCode = 1'
  ].join('\n'))

  try {
    await assert.rejects(runPiWorker(input, { workerPath }), (error: unknown) => {
      assert.ok(error instanceof Error && 'code' in error && error.code === 'pi_worker_failed')
      assert.ok('workerModel' in error)
      assert.deepEqual(error.workerModel, SESSION_MODEL)
      return true
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runPiWorker: timeout では SIGTERM が worker に届き agent_timeout になる', async () => {
  const root = await makeTempDir()
  const input = await createWorkerInput(root)
  const marker = path.join(input.stateDir, 'sigterm')
  const workerPath = await writeFakeWorker(root, [
    "process.on('SIGTERM', () => {",
    "  fs.writeFileSync(path.join(input.stateDir, 'sigterm'), 'received')",
    "  process.stdout.write(JSON.stringify({ status: 'failed', errorName: 'AbortError', errorMessage: 'aborted' }))",
    '  process.exit(1)',
    '})',
    'setInterval(() => {}, 1000)'
  ].join('\n'))

  try {
    const startedAt = Date.now()
    await assert.rejects(runPiWorker(input, { workerPath }), (error: unknown) => {
      return error instanceof Error &&
        'code' in error && error.code === 'agent_timeout' &&
        'terminationConfirmed' in error && error.terminationConfirmed === true
    })
    assert.equal(await fs.readFile(marker, 'utf8'), 'received')
    assert.ok(Date.now() - startedAt < 5000)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runPiWorker: SIGTERM を無視する worker は猶予の後に SIGKILL される', async () => {
  const root = await makeTempDir()
  const input = await createWorkerInput(root)
  const workerPath = await writeFakeWorker(root, [
    "process.on('SIGTERM', () => { fs.writeFileSync(path.join(input.stateDir, 'sigterm'), 'ignored') })",
    'setInterval(() => {}, 1000)'
  ].join('\n'))

  try {
    const startedAt = Date.now()
    await assert.rejects(runPiWorker(input, { workerPath, terminationGraceMs: 500 }), hasCode('agent_timeout'))
    assert.ok(Date.now() - startedAt >= 1500)
    assert.equal(await fs.readFile(path.join(input.stateDir, 'sigterm'), 'utf8'), 'ignored')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runPiWorker: 不正な応答は pi_worker_invalid_response', async () => {
  const root = await makeTempDir()
  const input = await createWorkerInput(root)
  const invalidJson = await writeFakeWorker(root, "process.stdout.write('not json')")
  const unknownShape = await writeFakeWorker(root, "process.stdout.write(JSON.stringify({ status: 'failed', errorName: 'Error' }))")

  try {
    await assert.rejects(runPiWorker(input, { workerPath: invalidJson }), hasCode('pi_worker_invalid_response'))
    await assert.rejects(runPiWorker(input, { workerPath: unknownShape }), hasCode('pi_worker_invalid_response'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('parsePiWorkerResult: 終了の状態ごとに安定した code を返す', () => {
  const completed = JSON.stringify({ status: 'completed', summary: 'done', model: SESSION_MODEL })
  const cases = [
    { result: makeResult({ terminationConfirmed: false, terminationReason: 'timeout' }), code: 'termination_unconfirmed' },
    { result: makeResult({ terminationReason: 'output_overflow' }), code: 'pi_worker_output_overflow' },
    { result: makeResult({ terminationReason: 'invalid_utf8' }), code: 'pi_worker_invalid_utf8' },
    { result: makeResult({ stdout: completed, signal: 'SIGTERM' }), code: 'pi_worker_signal_exit' },
    { result: makeResult({ stdout: completed, exitCode: null }), code: 'pi_worker_exit_unknown' },
    { result: makeResult({ stdout: completed, exitCode: 2 }), code: 'pi_worker_nonzero_exit' },
    { result: makeResult({ stdout: JSON.stringify({ status: 'completed', summary: ' ', model: SESSION_MODEL }) }), code: 'pi_worker_empty_summary' },
    {
      result: makeResult({ stdout: JSON.stringify({ status: 'failed', errorName: 'bad name', errorMessage: 'x', model: null }) }),
      code: 'pi_worker_invalid_response'
    },
    {
      result: makeResult({ stdout: JSON.stringify({ status: 'failed', errorName: 'Error', errorMessage: 'x'.repeat(501), model: null }) }),
      code: 'pi_worker_invalid_response'
    }
  ]

  for (const sample of cases) {
    assert.throws(() => {
      parsePiWorkerResult(sample.result)
    }, hasCode(sample.code), sample.code)
  }

  assert.throws(() => {
    parsePiWorkerResult(makeResult({ terminationConfirmed: false }))
  }, (error: unknown) => {
    return error instanceof Error && 'terminationConfirmed' in error && error.terminationConfirmed === false
  })
  assert.deepEqual(parsePiWorkerResult(makeResult({ stdout: JSON.stringify({ status: 'completed', summary: 'あ'.repeat(5000), model: SESSION_MODEL }) })), {
    summary: 'あ'.repeat(4000),
    model: SESSION_MODEL
  })
})

test('parsePiWorkerResult: 出力の model を厳密に検証し、不正な値は pi_worker_invalid_response にする', () => {
  const invalidModels = [
    { name: '文字列', model: 'openai/gpt-5.5' },
    { name: 'key が足りない', model: { provider: 'openai', id: 'gpt-5.5' } },
    { name: '余分な key', model: { ...SESSION_MODEL, source: 'pi-settings' } },
    { name: '空の provider', model: { ...SESSION_MODEL, provider: '' } },
    { name: '空の id', model: { ...SESSION_MODEL, id: '' } },
    { name: '200文字超の id', model: { ...SESSION_MODEL, id: 'm'.repeat(201) } },
    { name: '制御文字を含む provider', model: { ...SESSION_MODEL, provider: 'open\nai' } },
    { name: '数値の id', model: { ...SESSION_MODEL, id: 5 } },
    { name: '不正な thinkingLevel', model: { ...SESSION_MODEL, thinkingLevel: 'extreme' } },
    { name: 'null の thinkingLevel', model: { ...SESSION_MODEL, thinkingLevel: null } }
  ]
  const cases = [
    { name: 'completed に model が無い', response: { status: 'completed', summary: 'done' } },
    { name: 'completed の model が null', response: { status: 'completed', summary: 'done', model: null } },
    { name: 'failed に model が無い', response: { status: 'failed', errorName: 'Error', errorMessage: 'x' } },
    { name: 'completed に余分な key', response: { status: 'completed', summary: 'done', model: SESSION_MODEL, extra: true } },
    ...invalidModels.flatMap((sample) => {
      return [
        { name: `completed: ${sample.name}`, response: { status: 'completed', summary: 'done', model: sample.model } },
        { name: `failed: ${sample.name}`, response: { status: 'failed', errorName: 'Error', errorMessage: 'x', model: sample.model } }
      ]
    })
  ]

  for (const sample of cases) {
    assert.throws(() => {
      parsePiWorkerResult(makeResult({ stdout: JSON.stringify(sample.response), exitCode: sample.response.status === 'failed' ? 1 : 0 }))
    }, hasCode('pi_worker_invalid_response'), sample.name)
  }

  // provider と id は200文字まで、空白は出力では拒否しない
  const longModel = { provider: 'p'.repeat(200), id: 'id with space', thinkingLevel: 'off' }
  assert.deepEqual(parsePiWorkerResult(makeResult({ stdout: JSON.stringify({ status: 'completed', summary: 'done', model: longModel }) })), {
    summary: 'done',
    model: longModel
  })
})

test('development worker: 不正な入力には failed の応答を返して exit code 1 で終わる', async () => {
  const root = await makeTempDir()
  const workerPath = fileURLToPath(new URL('../bin/development-worker.ts', import.meta.url))
  const valid = {
    agentDir: path.join(root, 'pi-agent'),
    devRoot: path.join(root, 'dev'),
    stateDir: path.join(root, 'state'),
    task: 'Do nothing.',
    taskKey: TASK_KEY,
    timeoutMs: 1000,
    title: 'Invalid worker input',
    model: { provider: 'openai', id: 'gpt-5.5', thinkingLevel: 'high' }
  }
  const { model: _model, ...missingModel } = valid
  const { title: _title, ...missingTitle } = valid
  const cases = [
    { name: 'missing key', input: missingTitle, message: /exactly these fields/u },
    { name: 'extra key', input: { ...valid, repository: 'agentctl' }, message: /exactly these fields/u },
    { name: 'relative agentDir', input: { ...valid, agentDir: 'pi-agent' }, message: /agentDir must be an absolute path/u },
    { name: 'relative devRoot', input: { ...valid, devRoot: 'dev' }, message: /devRoot must be an absolute path/u },
    { name: 'relative stateDir', input: { ...valid, stateDir: './state' }, message: /stateDir must be an absolute path/u },
    { name: 'invalid taskKey', input: { ...valid, taskKey: 'development-XYZ' }, message: /taskKey is invalid/u },
    { name: 'invalid timeout', input: { ...valid, timeoutMs: 10 }, message: /timeout is invalid/u },
    { name: 'missing model', input: missingModel, message: /exactly these fields/u },
    { name: 'string model', input: { ...valid, model: 'openai/gpt-5.5' }, message: /model must be null or an object with exactly these fields/u },
    { name: 'model without thinkingLevel', input: { ...valid, model: { provider: 'openai', id: 'gpt-5.5' } }, message: /model must be null or an object/u },
    { name: 'model with extra key', input: { ...valid, model: { ...valid.model, source: 'araya-config' } }, message: /model must be null or an object/u },
    { name: 'provider with slash', input: { ...valid, model: { ...valid.model, provider: 'open/ai' } }, message: /worker model must be a "<provider>\/<model id>"/u },
    { name: 'empty id', input: { ...valid, model: { ...valid.model, id: '' } }, message: /worker model must be a "<provider>\/<model id>"/u },
    { name: 'id with space', input: { ...valid, model: { ...valid.model, id: 'gpt 5.5' } }, message: /worker model must be a "<provider>\/<model id>"/u },
    { name: 'id with control', input: { ...valid, model: { ...valid.model, id: 'gpt-5.5\u0000' } }, message: /worker model must be a "<provider>\/<model id>"/u },
    { name: 'too long model', input: { ...valid, model: { ...valid.model, id: 'm'.repeat(194) } }, message: /worker model must be a "<provider>\/<model id>"/u },
    { name: 'invalid thinkingLevel', input: { ...valid, model: { ...valid.model, thinkingLevel: 'extreme' } }, message: /thinkingLevel must be null or one of/u }
  ]

  try {
    for (const sample of cases) {
      const result = spawnSync(process.execPath, [workerPath], {
        cwd: root,
        env: { HOME: root, PI_CODING_AGENT_DIR: valid.agentDir },
        input: JSON.stringify(sample.input),
        encoding: 'utf8',
        timeout: 30_000
      })
      const response: unknown = JSON.parse(result.stdout)

      assert.equal(result.status, 1, sample.name)
      assert.ok(typeof response === 'object' && response !== null, sample.name)
      assert.deepEqual(Object.keys(response).sort(), ['errorMessage', 'errorName', 'model', 'status'], sample.name)
      assert.ok('status' in response && response.status === 'failed', sample.name)
      assert.ok('model' in response && response.model === null, sample.name)
      assert.ok('errorMessage' in response && typeof response.errorMessage === 'string', sample.name)
      assert.match(response.errorMessage, sample.message, sample.name)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development worker: 指定した model が使えなければ、session を作らずに ModelUnavailableError と null の model を返す', async () => {
  const root = await makeTempDir()
  const input = await createWorkerInput(root)
  // 本物の認証情報を使わないように dummy の key だけを置き、host の環境変数は worker に渡さない
  await fs.writeFile(path.join(input.agentDir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'dummy-test-key' } }), 'utf8')
  await fs.writeFile(path.join(input.agentDir, 'models.json'), JSON.stringify({
    providers: {
      'araya-test-local': { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', models: [{ id: 'no-auth-model' }] }
    }
  }), 'utf8')
  const cases = [
    {
      model: { provider: 'openai', id: 'gpt-araya-missing', thinkingLevel: 'high' as const },
      message: 'configured model openai/gpt-araya-missing is not in the Pi model list'
    },
    {
      model: { provider: 'araya-test-local', id: 'no-auth-model', thinkingLevel: null },
      message: 'configured model araya-test-local/no-auth-model has no Pi authentication'
    }
  ]

  try {
    for (const sample of cases) {
      await assert.rejects(runPiWorker({ ...input, model: sample.model, timeoutMs: 30_000, env: { HOME: root } }), (error: unknown) => {
        assert.ok(error instanceof Error && 'code' in error && error.code === 'pi_worker_failed', sample.message)
        assert.ok('workerErrorName' in error && error.workerErrorName === 'ModelUnavailableError', sample.message)
        assert.ok('workerErrorMessage' in error && error.workerErrorMessage === sample.message, sample.message)
        assert.equal('workerModel' in error, false, sample.message)
        return true
      })
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development worker: session の model が決まった後に model の error で失敗すると、failed の出力に使った model を入れる', async () => {
  const root = await makeTempDir()
  const input = await createWorkerInput(root)
  const requests: string[] = []
  // 外部の model API に接続しないように、すべての request を HTTP 400 で拒否する stub server を使う
  const server = http.createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`)
    request.resume()
    request.on('end', () => {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'araya stub rejects every request', type: 'invalid_request_error' } }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address: AddressInfo | string | null = server.address()

  try {
    assert.ok(address !== null && typeof address === 'object')
    await fs.writeFile(path.join(input.agentDir, 'models.json'), JSON.stringify({
      providers: {
        'araya-test-stub': {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: 'openai-completions',
          models: [{ id: 'stub-model' }]
        }
      }
    }), 'utf8')
    // 本物の認証情報を使わないように、dummy の key だけを置く
    await fs.writeFile(path.join(input.agentDir, 'auth.json'), JSON.stringify({
      'araya-test-stub': { type: 'api_key', key: 'dummy-test-key' }
    }), 'utf8')
    // Pi の自動 retry で待たないようにする
    await fs.writeFile(path.join(input.agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false } }), 'utf8')

    const workerPath = fileURLToPath(new URL('../bin/development-worker.ts', import.meta.url))
    const result = await runBoundedCommand(process.execPath, [workerPath], {
      cwd: input.devRoot,
      // host の環境変数（API key など）は worker に渡さない
      env: { HOME: root, PI_CODING_AGENT_DIR: input.agentDir },
      input: JSON.stringify({
        agentDir: input.agentDir,
        devRoot: input.devRoot,
        // reasoning に対応しない model なので、Pi は high を off に丸める
        model: { provider: 'araya-test-stub', id: 'stub-model', thinkingLevel: 'high' },
        stateDir: input.stateDir,
        task: input.task,
        taskKey: input.taskKey,
        timeoutMs: 30_000,
        title: input.title
      }),
      timeoutMs: 30_000,
      stdout: { mode: 'strict', limitBytes: 64 * 1024 },
      stderr: { mode: 'tail', limitBytes: 8 * 1024 }
    })
    const response: unknown = JSON.parse(result.stdout)

    assert.equal(result.terminationReason, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.exitCode, 1)
    assert.ok(typeof response === 'object' && response !== null)
    assert.deepEqual(Object.keys(response).sort(), ['errorMessage', 'errorName', 'model', 'status'])
    assert.ok('status' in response && response.status === 'failed')
    assert.ok('errorMessage' in response && typeof response.errorMessage === 'string')
    assert.match(response.errorMessage, /Pi session ended with a model error/u)
    assert.ok('model' in response)
    assert.deepEqual(response.model, { provider: 'araya-test-stub', id: 'stub-model', thinkingLevel: 'off' })
    assert.ok(requests.length >= 1)
    assert.ok(requests.every((request) => {
      return request === 'POST /v1/chat/completions'
    }), JSON.stringify(requests))
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    await fs.rm(root, { recursive: true, force: true })
  }
})
