import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parsePiWorkerResult,
  runBoundedCommand,
  type BoundedProcessResult
} from '../src/development-sandbox.ts'

function makeResult(overrides: Partial<BoundedProcessResult> = {}): BoundedProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    terminationReason: undefined,
    terminationConfirmed: true,
    ...overrides
  }
}

test('Pi worker failure responses map to stable, specific error codes', () => {
  assert.equal(typeof parsePiWorkerResult, 'function', 'Pi worker result parser should be exposed for contract tests')

  if (typeof parsePiWorkerResult !== 'function') {
    return
  }

  const completedResponse = JSON.stringify({ status: 'completed', summary: 'done' })
  const cases: { name: string; result: BoundedProcessResult; code: string }[] = [
    {
      name: 'unconfirmed termination',
      result: makeResult({ terminationConfirmed: false }),
      code: 'process_termination_unconfirmed'
    },
    {
      name: 'timeout',
      result: makeResult({ terminationReason: 'timeout' }),
      code: 'pi_worker_timeout'
    },
    {
      name: 'output overflow',
      result: makeResult({ terminationReason: 'output_overflow' }),
      code: 'pi_worker_output_overflow'
    },
    {
      name: 'invalid UTF-8',
      result: makeResult({ terminationReason: 'invalid_utf8' }),
      code: 'pi_worker_invalid_utf8'
    },
    {
      name: 'invalid response',
      result: makeResult({ stdout: '{' }),
      code: 'pi_worker_invalid_response'
    },
    {
      name: 'non-zero exit',
      result: makeResult({ stdout: completedResponse, exitCode: 1 }),
      code: 'pi_worker_nonzero_exit'
    },
    {
      name: 'signal exit',
      result: makeResult({ stdout: completedResponse, signal: 'SIGTERM' }),
      code: 'pi_worker_signal_exit'
    },
    {
      name: 'unknown exit status',
      result: makeResult({ stdout: completedResponse, exitCode: null }),
      code: 'pi_worker_exit_unknown'
    },
    {
      name: 'worker error response',
      result: makeResult({
        stdout: JSON.stringify({ status: 'failed', errorName: 'ApiError' }),
        exitCode: 1
      }),
      code: 'pi_worker_failed'
    },
    {
      name: 'empty summary',
      result: makeResult({ stdout: JSON.stringify({ status: 'completed', summary: '  ' }) }),
      code: 'pi_worker_empty_summary'
    }
  ]

  for (const sample of cases) {
    assert.throws(() => {
      parsePiWorkerResult(sample.result)
    }, (error: unknown) => {
      return error instanceof Error &&
        'code' in error &&
        error.code === sample.code &&
        (sample.code !== 'pi_worker_failed' || ('workerErrorName' in error && error.workerErrorName === 'ApiError'))
    }, sample.name)
  }

  const parsed = parsePiWorkerResult(makeResult({ stdout: completedResponse }))
  assert.deepEqual(parsed, { summary: 'done' })
})

test('bounded subprocess launch failures have a stable code', async () => {
  await assert.rejects(
    runBoundedCommand('/__araya_test__/missing-executable', [], {
      env: {},
      timeoutMs: 1000
    }),
    (error: unknown) => {
      return error instanceof Error && 'code' in error && error.code === 'subprocess_launch_failed'
    }
  )
})

test('bounded process rejects malformed UTF-8 from persisted stderr', async () => {
  const result = await runBoundedCommand(process.execPath, [
    '-e',
    'process.stderr.write(Buffer.from([0xff]))'
  ], {
    env: {},
    timeoutMs: 1000
  })

  assert.equal(result.terminationReason, 'invalid_utf8')
  assert.equal(result.terminationConfirmed, true)
})
