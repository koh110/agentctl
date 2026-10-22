import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent'

import { DEVELOPMENT_TOOL_NAMES, runDevelopmentAgent } from '../src/development-agent.ts'

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'araya-development-agent-test-'))
}

function createSessionStub(toolNames: string[], options: {
  hasModel?: boolean
  summary?: string
} = {}) {
  const prompts: string[] = []
  const calls = { prompts, disposed: false }
  const session = {
    hasModel: options.hasModel ?? true,
    activeToolNames: () => [...toolNames],
    callableToolNames: () => [...toolNames],
    async sendUserMessage(prompt: string) {
      calls.prompts.push(prompt)
    },
    lastAssistantText: () => options.summary ?? 'Implemented the requested change.',
    dispose() {
      calls.disposed = true
    }
  }

  return { calls, session }
}

test('development agent loads only the exact workspace tool allowlist and returns the final summary', async () => {
  const root = await makeTempDir()
  const workspacePath = path.join(root, 'workspace')
  const agentDir = path.join(root, 'pi-agent')
  await fs.mkdir(workspacePath)
  await fs.mkdir(agentDir)
  const stub = createSessionStub([...DEVELOPMENT_TOOL_NAMES])
  let sessionOptions: CreateAgentSessionOptions | undefined

  try {
    const result = await runDevelopmentAgent({
      title: 'Add an input check',
      task: 'Reject empty values.',
      workspacePath,
      agentDir
    }, {
      createSession: async (options) => {
        sessionOptions = options
        return stub.session
      }
    })

    assert.deepEqual(result, { summary: 'Implemented the requested change.' })
    assert.equal(stub.calls.prompts.length, 1)
    assert.match(stub.calls.prompts[0] ?? '', /Reject empty values\./u)
    assert.equal(stub.calls.disposed, true)

    if (sessionOptions === undefined) {
      throw new Error('agent session options were not captured')
    }

    assert.equal(sessionOptions.cwd, workspacePath)
    assert.equal(sessionOptions.noTools, 'all')
    assert.deepEqual(sessionOptions.tools, [...DEVELOPMENT_TOOL_NAMES])
    assert.deepEqual(
      sessionOptions.customTools?.map((tool) => tool.name).sort(),
      [...DEVELOPMENT_TOOL_NAMES].sort()
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development agent rejects any extra callable tool before sending the task', async () => {
  const root = await makeTempDir()
  const workspacePath = path.join(root, 'workspace')
  const agentDir = path.join(root, 'pi-agent')
  await fs.mkdir(workspacePath)
  await fs.mkdir(agentDir)
  const stub = createSessionStub([...DEVELOPMENT_TOOL_NAMES, 'bash'])

  try {
    await assert.rejects(runDevelopmentAgent({
      title: 'Do not enable shell',
      task: 'Make a source change.',
      workspacePath,
      agentDir
    }, {
      createSession: async () => stub.session
    }), /tool set does not match/u)
    assert.equal(stub.calls.prompts.length, 0)
    assert.equal(stub.calls.disposed, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('development agent refuses to start when the Pi session has no model', async () => {
  const root = await makeTempDir()
  const workspacePath = path.join(root, 'workspace')
  const agentDir = path.join(root, 'pi-agent')
  await fs.mkdir(workspacePath)
  await fs.mkdir(agentDir)
  const stub = createSessionStub([...DEVELOPMENT_TOOL_NAMES], { hasModel: false })

  try {
    await assert.rejects(runDevelopmentAgent({
      title: 'No model',
      task: 'Do not send a request.',
      workspacePath,
      agentDir
    }, {
      createSession: async () => stub.session
    }), /no configured Pi model/u)
    assert.equal(stub.calls.prompts.length, 0)
    assert.equal(stub.calls.disposed, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
