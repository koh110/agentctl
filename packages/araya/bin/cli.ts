#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { parseCliArguments } from '../src/arguments.ts'
import { loadConfig } from '../src/config.ts'
import {
  approveOpportunity,
  initAraya,
  rejectOpportunity,
  runAraya,
  statusAraya,
  tickAraya
} from '../src/operations.ts'

function printHelp(): void {
  console.log(`araya MVP

使い方:
  araya
    引数なし: pi を起動する。tick は自動では実行しない。

  araya pi [arguments...]
    pi を起動し、指定した引数をそのまま渡す。

  araya --help
    このヘルプを表示する。

  araya init
    状態領域と seed inbox を作成し、初期状態を status.json へ書き出す。

  araya tick
    1回だけ due goal を処理し、Scout task を完了まで待つ。

  araya status
    control plane と live task graph を読み、status.json へ書き出す。

  araya run
    ARAYA_INTERVAL_MS ごとに tick を繰り返す。Ctrl+C で停止する。

  araya approve <opportunityId> [note...]
    承認待ち候補を承認する。外部実行はまだ行わない。

  araya reject <opportunityId> [note...]
    候補を却下する。

環境変数:
  ARAYA_DATA_DIR
  ARAYA_INBOX_DIR
  ARAYA_STATUS_FILE
  ARAYA_CONTROL_PLANE_PATH
  ARAYA_PI_DURABLE_PATH
  ARAYA_INTERVAL_MS
  ARAYA_MAX_ACTIONS
`)
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

async function runPi(args: string[]): Promise<void> {
  const child = spawn('pi', args, { stdio: 'inherit', shell: false })

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      process.exitCode = signal === null ? code ?? 1 : 1
      resolve()
    })
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    await runPi([])
    return
  }

  if (args[0] === 'pi') {
    await runPi(args.slice(1))
    return
  }

  const { help, positionals } = parseCliArguments(args)
  const command = positionals[0] ?? 'help'

  if (help || command === 'help') {
    printHelp()
    return
  }

  const config = loadConfig()

  if (command === 'init') {
    printJson(await initAraya(config))
    return
  }

  if (command === 'tick') {
    printJson(await tickAraya(config))
    return
  }

  if (command === 'status') {
    printJson(await statusAraya(config))
    return
  }

  if (command === 'run') {
    await runAraya(config)
    return
  }

  if (command === 'approve' || command === 'reject') {
    const opportunityId = positionals[1]

    if (opportunityId === undefined || opportunityId === '') {
      throw new Error(`${command} には opportunityId が必要です`)
    }

    const note = positionals.slice(2).join(' ')
    const result = command === 'approve'
      ? approveOpportunity(config, opportunityId, note)
      : rejectOpportunity(config, opportunityId, note)

    printJson(result)
    return
  }

  printHelp()
  throw new Error(`不明な command: ${command}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
