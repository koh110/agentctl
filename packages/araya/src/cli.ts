import { parseCliArguments } from './arguments.ts'
import { loadConfig } from './config.ts'
import {
  approveOpportunity,
  initAraya,
  rejectOpportunity,
  runAraya,
  statusAraya,
  tickAraya
} from './operations.ts'

async function launchPi(args: string[]) {
  const { main } = await import('@earendil-works/pi-coding-agent')
  await main(args)
}

function printHelp() {
  console.log(`araya MVP

使い方:
  araya
    引数なし: Pi の interactive TUI を同じプロセス内で起動する。tick は自動では実行しない。

  araya pi [arguments...]
    Pi に指定した引数を渡して起動する。

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

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

export async function runCli(args: string[], startPi = launchPi) {
  if (args.length === 0) {
    await startPi([])
    return
  }

  if (args[0] === 'pi') {
    await startPi(args.slice(1))
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
