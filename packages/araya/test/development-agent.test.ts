import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent'

import { DEVELOPMENT_TOOL_NAMES, findAssistantFailure, hasUsableModel, runDevelopmentAgent } from '../src/development-agent.ts'
import type { DevelopmentModel, SessionModel } from '../src/development-model.ts'
import { computeTaskKey, createTaskState, readTaskState } from '../src/development-worktrees.ts'

type Fixture = Awaited<ReturnType<typeof createFixture>>

async function createFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-development-agent-test-')))
  const home = path.join(root, 'home')
  const gitConfig = path.join(home, 'gitconfig')
  const devRoot = path.join(root, 'dev')
  const agentDir = path.join(root, 'pi-agent')
  const taskKey = computeTaskKey('development:agent-test')
  await fs.mkdir(home)
  await fs.mkdir(devRoot)
  await fs.mkdir(agentDir)
  await fs.writeFile(gitConfig, '', 'utf8')
  const stateDir = await createTaskState(path.join(root, 'data'), taskKey)
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

  return { root, devRoot, agentDir, stateDir, taskKey, env }
}

function createInput(fixture: Fixture, overrides: {
  signal?: AbortSignal
  model?: DevelopmentModel | null
  onSessionModel?: (model: SessionModel) => void
} = {}) {
  return {
    title: '入力検証を追加する',
    task: '空の値を拒否する。',
    devRoot: fixture.devRoot,
    stateDir: fixture.stateDir,
    taskKey: fixture.taskKey,
    agentDir: fixture.agentDir,
    model: null,
    env: fixture.env,
    ...overrides
  }
}

// 本物の認証情報を使わないように、dummy の key だけを置く
async function writeDummyAuth(fixture: Fixture) {
  await fs.writeFile(
    path.join(fixture.agentDir, 'auth.json'),
    JSON.stringify({ openai: { type: 'api_key', key: 'dummy-test-key' } }),
    'utf8'
  )
}

async function writePiSettings(fixture: Fixture, settings: Record<string, unknown>) {
  await fs.writeFile(path.join(fixture.agentDir, 'settings.json'), JSON.stringify(settings), 'utf8')
}

function isModelUnavailable(message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'ModelUnavailableError')
    assert.equal(error.message, message)
    return true
  }
}

async function createRepository(fixture: Fixture, name: string) {
  const repositoryPath = path.join(fixture.devRoot, name)
  await fs.mkdir(repositoryPath)
  const git = (...args: string[]) => {
    return execFileSync('git', args, { cwd: repositoryPath, env: fixture.env, stdio: 'ignore' })
  }
  git('init', '-q', '-b', 'main')
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# fixture\n', 'utf8')
  git('add', '--all')
  git('commit', '-q', '-m', 'initial fixture')

  return repositoryPath
}

function createSessionStub(toolNames: readonly string[], options: {
  hasModel?: boolean
  model?: { provider: string; id: string }
  thinkingLevel?: SessionModel['thinkingLevel']
  summary?: string
  modelError?: string
  onPrompt?: (prompt: string) => Promise<void>
} = {}) {
  const prompts: string[] = []
  const calls = { prompts, aborts: 0, disposed: false }
  const session = {
    hasModel: options.hasModel ?? true,
    model: options.model ?? { provider: 'openai', id: 'gpt-5.5' },
    thinkingLevel: options.thinkingLevel ?? 'medium',
    activeToolNames: () => {
      return [...toolNames]
    },
    callableToolNames: () => {
      return [...toolNames]
    },
    async sendUserMessage(prompt: string) {
      calls.prompts.push(prompt)
      await options.onPrompt?.(prompt)
    },
    async abort() {
      calls.aborts += 1
    },
    lastAssistantText: () => {
      return options.summary ?? '変更しました。'
    },
    lastAssistantError: () => {
      return options.modelError
    },
    dispose() {
      calls.disposed = true
    }
  }

  return { calls, session }
}

function findTool(options: CreateAgentSessionOptions | undefined, name: string) {
  const tool = options?.customTools?.find((candidate) => {
    return candidate.name === name
  })

  if (tool === undefined) {
    throw new Error(`${name} was not passed to the session`)
  }

  return tool
}

// Pi の ExtensionToolContext を使わない tool なので、context なしで直接呼ぶ
async function callTool(options: CreateAgentSessionOptions | undefined, name: string, params: Record<string, unknown>) {
  const tool = findTool(options, name)
  const result: unknown = await Reflect.apply(tool.execute, tool, ['test-call', params, undefined, undefined, undefined])

  if (
    typeof result !== 'object' || result === null ||
    !('content' in result) || !Array.isArray(result.content)
  ) {
    throw new Error('tool result has no content')
  }

  const first: unknown = result.content[0]

  if (typeof first !== 'object' || first === null || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('tool result has no text content')
  }

  return { text: first.text, isError: 'isError' in result && result.isError === true }
}

test('development agent: tool 集合が9種類と一致しなければ prompt を送らずに失敗する', async () => {
  const fixture = await createFixture()

  try {
    for (const toolNames of [
      [...DEVELOPMENT_TOOL_NAMES, 'powershell'],
      DEVELOPMENT_TOOL_NAMES.filter((name) => {
        return name !== 'bash'
      })
    ]) {
      const stub = createSessionStub(toolNames)

      await assert.rejects(runDevelopmentAgent(createInput(fixture), {
        createSession: async () => {
          return stub.session
        }
      }), /tool set does not match/u)
      assert.equal(stub.calls.prompts.length, 0)
      assert.equal(stub.calls.disposed, true)
    }
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: tool 集合が一致すれば prompt を送り、最後の assistant の text を返す', async () => {
  const fixture = await createFixture()
  const stub = createSessionStub(DEVELOPMENT_TOOL_NAMES, { summary: `  ${'ま'.repeat(5000)}` })
  let sessionOptions: CreateAgentSessionOptions | undefined

  try {
    const result = await runDevelopmentAgent(createInput(fixture), {
      createSession: async (options) => {
        sessionOptions = options
        return stub.session
      }
    })

    assert.equal(result.summary.length, 4000)
    assert.equal(stub.calls.prompts.length, 1)
    assert.equal(stub.calls.disposed, true)
    assert.equal(sessionOptions?.cwd, fixture.devRoot)
    assert.equal(sessionOptions?.agentDir, fixture.agentDir)
    assert.equal(sessionOptions?.noTools, 'all')
    assert.deepEqual(sessionOptions?.tools, [...DEVELOPMENT_TOOL_NAMES])
    assert.deepEqual(sessionOptions?.customTools?.map((tool) => {
      return tool.name
    }).sort(), ['araya_create_worktree', 'araya_register_verification'])

    const prompt = stub.calls.prompts[0] ?? ''
    const systemPrompt = sessionOptions?.resourceLoader?.getSystemPrompt() ?? ''

    for (const text of [prompt, systemPrompt]) {
      assert.match(text, new RegExp(fixture.devRoot.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
      assert.match(text, new RegExp(`\\.worktree/araya-${fixture.taskKey}`, 'u'))
      assert.match(text, /araya_create_worktree/u)
      assert.match(text, /araya_register_verification/u)
      assert.match(text, /commit/u)
      assert.match(text, /日本語/u)
    }

    assert.match(prompt, /空の値を拒否する。/u)
    assert.match(prompt, /入力検証を追加する/u)
    assert.match(prompt, /作者が書いた課題/u)
    assert.match(systemPrompt, /main checkout/u)
    assert.match(systemPrompt, /origin\/main/u)
    assert.match(systemPrompt, /AGENTS\.md/u)
    assert.match(systemPrompt, /push/u)
    assert.match(systemPrompt, /認証情報/u)
    assert.match(systemPrompt, /Araya はあなたの終了後に/u)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: model の error で終わった応答は、途中まで text があっても失敗にする', async () => {
  const fixture = await createFixture()
  const stub = createSessionStub(DEVELOPMENT_TOOL_NAMES, { summary: '途中までの応答', modelError: 'provider overloaded' })

  try {
    await assert.rejects(runDevelopmentAgent(createInput(fixture), {
      createSession: async () => {
        return stub.session
      }
    }), /Pi session ended with a model error: provider overloaded/u)
    assert.equal(stub.calls.prompts.length, 1)
    assert.equal(stub.calls.disposed, true)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: 最後の assistant の応答が error か abort で終わったかを判定する', () => {
  assert.equal(findAssistantFailure([]), undefined)
  assert.equal(findAssistantFailure([{ role: 'user' }, { role: 'assistant', stopReason: 'stop' }]), undefined)
  assert.equal(findAssistantFailure([{ role: 'assistant', stopReason: 'error', errorMessage: 'overloaded' }]), 'overloaded')
  assert.equal(findAssistantFailure([{ role: 'assistant', stopReason: 'error' }]), 'model request ended with error')
  assert.equal(findAssistantFailure([{ role: 'assistant', stopReason: 'aborted' }]), 'model request ended with aborted')
  // 以前の応答が error でも、最後の assistant の応答が成功していれば失敗ではない
  assert.equal(findAssistantFailure([
    { role: 'assistant', stopReason: 'error', errorMessage: 'overloaded' },
    { role: 'user' },
    { role: 'assistant', stopReason: 'stop' }
  ]), undefined)
})

test('development agent: custom tool で worktree の作成と検証の登録ができる', async () => {
  const fixture = await createFixture()
  const repositoryPath = await createRepository(fixture, 'repo-a')
  const stub = createSessionStub(DEVELOPMENT_TOOL_NAMES)
  let sessionOptions: CreateAgentSessionOptions | undefined

  try {
    await runDevelopmentAgent(createInput(fixture), {
      createSession: async (options) => {
        sessionOptions = options
        return stub.session
      }
    })

    const created = await callTool(sessionOptions, 'araya_create_worktree', { repository: 'repo-a' })
    const worktreePath = path.join(repositoryPath, '.worktree', `araya-${fixture.taskKey}`)
    const createdValue: unknown = JSON.parse(created.text)

    assert.equal(created.isError, false)
    assert.ok(typeof createdValue === 'object' && createdValue !== null)
    assert.deepEqual(Object.keys(createdValue).sort(), ['baseSha', 'branch', 'excludeAdded', 'worktreePath'])
    assert.ok('worktreePath' in createdValue && createdValue.worktreePath === worktreePath)
    assert.ok('branch' in createdValue && createdValue.branch === `araya/${fixture.taskKey}`)
    assert.ok('excludeAdded' in createdValue && createdValue.excludeAdded === true)
    assert.equal((await fs.stat(worktreePath)).isDirectory(), true)

    const registered = await callTool(sessionOptions, 'araya_register_verification', {
      repository: 'repo-a',
      command: ['npm', 'test'],
      cwd: 'packages/app'
    })

    assert.equal(registered.isError, false)
    assert.match(registered.text, /"command":\["npm","test"\]/u)

    const failed = await callTool(sessionOptions, 'araya_register_verification', {
      repository: 'repo-b',
      command: ['npm', 'test']
    })

    assert.equal(failed.isError, true)
    assert.match(failed.text, /repository_not_found/u)

    const state = await readTaskState({ devRoot: fixture.devRoot, stateDir: fixture.stateDir, taskKey: fixture.taskKey })
    assert.equal(state.worktrees.length, 1)
    assert.deepEqual(state.verifications.map(({ repository, command, cwd }) => {
      return { repository, command, cwd }
    }), [{ repository: 'repo-a', command: ['npm', 'test'], cwd: 'packages/app' }])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: signal の abort で session.abort() を呼び AbortError になる', async () => {
  const fixture = await createFixture()
  const controller = new AbortController()
  const stub = createSessionStub(DEVELOPMENT_TOOL_NAMES, {
    onPrompt: async () => {
      controller.abort()
      await new Promise((resolve) => {
        setImmediate(resolve)
      })
    }
  })

  try {
    await assert.rejects(runDevelopmentAgent(createInput(fixture, { signal: controller.signal }), {
      createSession: async () => {
        return stub.session
      }
    }), { name: 'AbortError' })
    assert.equal(stub.calls.prompts.length, 1)
    assert.equal(stub.calls.aborts, 1)
    assert.equal(stub.calls.disposed, true)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: 開始前に abort されていれば session を作らない', async () => {
  const fixture = await createFixture()
  const controller = new AbortController()
  controller.abort()
  let created = false

  try {
    await assert.rejects(runDevelopmentAgent(createInput(fixture, { signal: controller.signal }), {
      createSession: async () => {
        created = true
        return createSessionStub(DEVELOPMENT_TOOL_NAMES).session
      }
    }), { name: 'AbortError' })
    assert.equal(created, false)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: model が無ければ prompt を送らずに失敗する', async () => {
  const fixture = await createFixture()
  const stub = createSessionStub(DEVELOPMENT_TOOL_NAMES, { hasModel: false })

  try {
    await assert.rejects(runDevelopmentAgent(createInput(fixture), {
      createSession: async () => {
        return stub.session
      }
    }), /no configured Pi model/u)
    assert.equal(stub.calls.prompts.length, 0)
    assert.equal(stub.calls.disposed, true)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: 実際の Pi session は9種類の tool だけを公開する', async () => {
  const fixture = await createFixture()
  const noNames: string[] = []
  const toolNames = { active: noNames, callable: noNames }

  try {
    await assert.rejects(runDevelopmentAgent(createInput(fixture), {
      createSession: async (options) => {
        const { session } = await createAgentSession(options)
        toolNames.active = session.getActiveToolNames()
        toolNames.callable = session.getCallableToolNames()
        session.dispose()

        // 実モデルを呼ばないように、model の無い session として返す
        return createSessionStub([], { hasModel: false }).session
      }
    }), /no configured Pi model/u)
    assert.deepEqual(toolNames.active.sort(), [...DEVELOPMENT_TOOL_NAMES].sort())
    assert.deepEqual(toolNames.callable.sort(), [...DEVELOPMENT_TOOL_NAMES].sort())
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: 認証を設定済みの model だけを使える model とみなす', async () => {
  const fixture = await createFixture()
  await fs.writeFile(
    path.join(fixture.agentDir, 'auth.json'),
    JSON.stringify({ openai: { type: 'api_key', key: 'test-only-not-a-real-credential' } }),
    'utf8'
  )

  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(fixture.agentDir, 'auth.json'),
      modelsPath: path.join(fixture.agentDir, 'models.json'),
      modelsStorePath: path.join(fixture.stateDir, 'models-store.json'),
      allowModelNetwork: false,
      refreshOnCreate: false
    })
    await modelRuntime.refresh({ allowNetwork: false })
    const openaiModel = modelRuntime.getModels('openai')[0]

    assert.ok(openaiModel !== undefined)
    assert.equal(hasUsableModel(openaiModel, modelRuntime), true)
    assert.equal(hasUsableModel({ provider: 'unknown', id: 'unknown' }, modelRuntime), false)
    assert.equal(hasUsableModel(undefined, modelRuntime), false)
    assert.equal(hasUsableModel(openaiModel, undefined), false)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: auth.json の model を network なしで選べる', async () => {
  const fixture = await createFixture()
  await fs.writeFile(
    path.join(fixture.agentDir, 'auth.json'),
    JSON.stringify({ openai: { type: 'api_key', key: 'test-only-not-a-real-credential' } }),
    'utf8'
  )
  // 利用者の環境変数の API key に左右されないように、既定の provider を settings で決める
  await fs.writeFile(path.join(fixture.agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'openai' }), 'utf8')
  const selected = { provider: '', usable: false }

  try {
    await assert.rejects(runDevelopmentAgent(createInput(fixture), {
      createSession: async (options) => {
        const { session } = await createAgentSession(options)
        selected.provider = session.model?.provider ?? ''
        selected.usable = hasUsableModel(session.model, options.modelRuntime)
        session.dispose()

        // prompt を送らないように、model の無い session として返す
        return createSessionStub([], { hasModel: false }).session
      }
    }), /no configured Pi model/u)
    assert.deepEqual(selected, { provider: 'openai', usable: true })
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: 指定した model が Pi の model 一覧に無ければ、session を作らずに ModelUnavailableError で失敗する', async () => {
  const fixture = await createFixture()
  await writeDummyAuth(fixture)
  const reported: SessionModel[] = []
  let created = false

  try {
    await assert.rejects(runDevelopmentAgent(createInput(fixture, {
      model: { provider: 'openai', id: 'gpt-araya-missing', thinkingLevel: 'high' },
      onSessionModel: (model) => {
        reported.push(model)
      }
    }), {
      createSession: async () => {
        created = true
        return createSessionStub(DEVELOPMENT_TOOL_NAMES).session
      }
    }), isModelUnavailable('configured model openai/gpt-araya-missing is not in the Pi model list'))
    assert.equal(created, false)
    assert.deepEqual(reported, [])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: 指定した model に Pi の認証が無ければ、session を作らずに ModelUnavailableError で失敗する', async () => {
  const fixture = await createFixture()
  await writeDummyAuth(fixture)
  // 環境変数の API key に左右されないように、認証を持たない provider を models.json で定義する
  await fs.writeFile(path.join(fixture.agentDir, 'models.json'), JSON.stringify({
    providers: {
      'araya-test-local': {
        baseUrl: 'http://127.0.0.1:9/v1',
        api: 'openai-completions',
        models: [{ id: 'no-auth-model' }]
      }
    }
  }), 'utf8')
  let created = false

  try {
    await assert.rejects(runDevelopmentAgent(createInput(fixture, {
      model: { provider: 'araya-test-local', id: 'no-auth-model', thinkingLevel: null }
    }), {
      createSession: async () => {
        created = true
        return createSessionStub(DEVELOPMENT_TOOL_NAMES).session
      }
    }), isModelUnavailable('configured model araya-test-local/no-auth-model has no Pi authentication'))
    assert.equal(created, false)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: 指定した model と thinking level を Pi session に渡し、Pi の既定 model より優先する', async () => {
  const fixture = await createFixture()
  await writeDummyAuth(fixture)
  await writePiSettings(fixture, { defaultProvider: 'openai', defaultModel: 'gpt-4o', defaultThinkingLevel: 'low' })
  const reported: SessionModel[] = []
  const passed = { model: '', thinkingLevel: '' }
  const stub = createSessionStub(DEVELOPMENT_TOOL_NAMES)

  try {
    const result = await runDevelopmentAgent(createInput(fixture, {
      model: { provider: 'openai', id: 'gpt-5.5', thinkingLevel: 'high' },
      onSessionModel: (model) => {
        reported.push(model)
      }
    }), {
      createSession: async (options) => {
        passed.model = `${options.model?.provider ?? ''}/${options.model?.id ?? ''}`
        passed.thinkingLevel = options.thinkingLevel ?? ''
        const { session } = await createAgentSession(options)
        const model = session.model === undefined ? undefined : { provider: session.model.provider, id: session.model.id }
        const thinkingLevel = session.thinkingLevel
        session.dispose()

        // 実モデルを呼ばないように、実際の session の model と thinking level を持つ stub を返す
        return {
          ...stub.session,
          hasModel: hasUsableModel(model, options.modelRuntime),
          ...(model === undefined ? {} : { model }),
          thinkingLevel
        }
      }
    })

    assert.deepEqual(passed, { model: 'openai/gpt-5.5', thinkingLevel: 'high' })
    assert.deepEqual(result.model, { provider: 'openai', id: 'gpt-5.5', thinkingLevel: 'high' })
    assert.deepEqual(reported, [{ provider: 'openai', id: 'gpt-5.5', thinkingLevel: 'high' }])
    assert.equal(stub.calls.prompts.length, 1)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: thinkingLevel を省略すると Pi の設定の thinking level を使い、丸めた後の値を返す', async () => {
  const fixture = await createFixture()
  await writeDummyAuth(fixture)
  await writePiSettings(fixture, { defaultThinkingLevel: 'low', modelThinkingLevels: { 'openai/gpt-5.5': 'xhigh' } })
  const samples = [
    { model: { provider: 'openai', id: 'gpt-5.5', thinkingLevel: null }, expected: 'xhigh' },
    { model: { provider: 'openai', id: 'gpt-5.4', thinkingLevel: null }, expected: 'low' },
    // reasoning に対応しない model では Pi が off に丸める
    { model: { provider: 'openai', id: 'gpt-4o', thinkingLevel: 'high' as const }, expected: 'off' }
  ]

  try {
    for (const sample of samples) {
      const stub = createSessionStub(DEVELOPMENT_TOOL_NAMES)
      let passedThinkingLevel: string | undefined
      const result = await runDevelopmentAgent(createInput(fixture, { model: sample.model }), {
        createSession: async (options) => {
          passedThinkingLevel = options.thinkingLevel
          const { session } = await createAgentSession(options)
          const model = session.model === undefined ? undefined : { provider: session.model.provider, id: session.model.id }
          const thinkingLevel = session.thinkingLevel
          session.dispose()

          return { ...stub.session, ...(model === undefined ? {} : { model }), thinkingLevel }
        }
      })

      assert.equal(passedThinkingLevel, sample.model.thinkingLevel ?? undefined, sample.model.id)
      assert.deepEqual(result.model, { provider: 'openai', id: sample.model.id, thinkingLevel: sample.expected }, sample.model.id)
    }
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: session の model が指定と違えば、prompt を送らずに ModelUnavailableError で失敗する', async () => {
  const fixture = await createFixture()
  await writeDummyAuth(fixture)
  const reported: SessionModel[] = []
  const stub = createSessionStub(DEVELOPMENT_TOOL_NAMES, { model: { provider: 'openai', id: 'gpt-4o' } })

  try {
    await assert.rejects(runDevelopmentAgent(createInput(fixture, {
      model: { provider: 'openai', id: 'gpt-5.5', thinkingLevel: null },
      onSessionModel: (model) => {
        reported.push(model)
      }
    }), {
      createSession: async () => {
        return stub.session
      }
    }), isModelUnavailable('Pi session model openai/gpt-4o does not match the configured model openai/gpt-5.5'))
    assert.equal(stub.calls.prompts.length, 0)
    assert.equal(stub.calls.disposed, true)
    assert.deepEqual(reported, [])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('development agent: model を指定しなければ Pi の設定で選んだ model を返し、model が決まった後の失敗でも model を知らせる', async () => {
  const fixture = await createFixture()
  const sessionModel = { provider: 'anthropic', id: 'claude-fable-5-1' }

  try {
    const reported: SessionModel[] = []
    const completed = await runDevelopmentAgent(createInput(fixture, {
      onSessionModel: (model) => {
        reported.push(model)
      }
    }), {
      createSession: async (options) => {
        assert.equal(options.model, undefined)
        assert.equal(options.thinkingLevel, undefined)
        return createSessionStub(DEVELOPMENT_TOOL_NAMES, { model: sessionModel, thinkingLevel: 'minimal' }).session
      }
    })

    assert.deepEqual(completed.model, { ...sessionModel, thinkingLevel: 'minimal' })
    assert.deepEqual(reported, [{ ...sessionModel, thinkingLevel: 'minimal' }])

    const failed: SessionModel[] = []
    await assert.rejects(runDevelopmentAgent(createInput(fixture, {
      onSessionModel: (model) => {
        failed.push(model)
      }
    }), {
      createSession: async () => {
        return createSessionStub([...DEVELOPMENT_TOOL_NAMES, 'powershell'], { model: sessionModel }).session
      }
    }), /tool set does not match/u)
    assert.deepEqual(failed, [{ ...sessionModel, thinkingLevel: 'medium' }])

    const noModel: SessionModel[] = []
    await assert.rejects(runDevelopmentAgent(createInput(fixture, {
      onSessionModel: (model) => {
        noModel.push(model)
      }
    }), {
      createSession: async () => {
        return createSessionStub(DEVELOPMENT_TOOL_NAMES, { hasModel: false }).session
      }
    }), /no configured Pi model/u)
    assert.deepEqual(noModel, [])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})
