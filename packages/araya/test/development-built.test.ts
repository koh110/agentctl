import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { runPiWorker as sourceRunner } from '../src/development-process.ts'
import { computeTaskKey } from '../src/development-worktrees.ts'

test('build 済みの package は JavaScript の worker を起動し、model が無いことを返す', async (context) => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const builtProcessPath = path.resolve(testDirectory, '../dist/src/development-process.js')

  try {
    await fs.access(builtProcessPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      context.skip('run npm run build before the compiled-worker integration test')
      return
    }

    throw error
  }

  const builtProcess = await import(pathToFileURL(builtProcessPath).href)
  const builtRunner: typeof sourceRunner = builtProcess.runPiWorker
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'araya-built-worker-')))
  const home = path.join(root, 'home')
  const devRoot = path.join(root, 'dev')
  const stateDir = path.join(root, 'state')
  const agentDir = path.join(root, 'empty-pi-agent')
  await fs.mkdir(home)
  await fs.mkdir(devRoot)
  await fs.mkdir(stateDir)
  await fs.mkdir(agentDir)

  try {
    await assert.rejects(builtRunner({
      devRoot,
      stateDir,
      taskKey: computeTaskKey('development:built-test'),
      agentDir,
      title: 'Do not make a model request',
      task: 'No model is configured in this isolated test.',
      timeoutMs: 30_000,
      env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') }
    }), (error: unknown) => {
      return error instanceof Error &&
        'code' in error && error.code === 'pi_worker_failed' &&
        'workerErrorMessage' in error && typeof error.workerErrorMessage === 'string' &&
        /no configured Pi model/u.test(error.workerErrorMessage)
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
