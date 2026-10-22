import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { runSandboxedPiAgent as sourceRunner } from '../src/development-sandbox.ts'

test('compiled package launches its emitted JavaScript Pi worker', async (context) => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const builtSandboxPath = path.resolve(testDirectory, '../dist/src/development-sandbox.js')

  try {
    await fs.access(builtSandboxPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      context.skip('run npm run build before the compiled-worker integration test')
      return
    }

    throw error
  }

  const builtSandbox = await import(pathToFileURL(builtSandboxPath).href)
  const builtRunner: typeof sourceRunner = builtSandbox.runSandboxedPiAgent
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'araya-built-worker-'))
  const workspacePath = path.join(root, 'worktree')
  const agentDir = path.join(root, 'empty-pi-agent')
  await fs.mkdir(workspacePath)
  await fs.mkdir(agentDir)
  await fs.writeFile(path.join(workspacePath, '.git'), 'gitdir: ../.git/worktrees/test\n', 'utf8')

  try {
    await assert.rejects(builtRunner({
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
