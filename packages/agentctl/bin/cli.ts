#!/usr/bin/env node
import { parseCliArguments } from '../src/arguments.ts'
import { loadConfig } from '../src/config.ts'
import {
  approveOpportunity,
  initAgentctl,
  rejectOpportunity,
  runAgentctl,
  statusAgentctl,
  tickAgentctl
} from '../src/operations.ts'

function printHelp(): void {
  console.log(`araya CLI

使い方:
  araya init
    状態領域と seed inbox を作成し、初期状態を status.json へ書き出す。

  araya tick
    1回だけ due goal を処理し、Scout task を完了まで待つ。

  araya status
    control plane と live task graph を読み、status.json へ書き出す。

  araya run
    AGENTCTL_INTERVAL_MS ごとに tick を繰り返す。Ctrl+C で停止する。

  araya approve <opportunityId> [note...]
    承認待ち候補を承認する。外部実行はまだ行わない。

  araya reject <opportunityId> [note...]
    候補を却下する。

環境変数:
  AGENTCTL_DATA_DIR
  AGENTCTL_INBOX_DIR
  AGENTCTL_STATUS_FILE
  AGENTCTL_CONTROL_PLANE_PATH
  AGENTCTL_PI_DURABLE_PATH
  AGENTCTL_INTERVAL_MS
  AGENTCTL_MAX_ACTIONS
`)
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

async function main(): Promise<void> {
  const { help, positionals } = parseCliArguments(process.argv.slice(2))
  const command = positionals[0] ?? 'help'

  if (help || command === 'help') {
    printHelp()
    return
  }

  const config = loadConfig()

  if (command === 'init') {
    printJson(await initAgentctl(config))
    return
  }

  if (command === 'tick') {
    printJson(await tickAgentctl(config))
    return
  }

  if (command === 'status') {
    printJson(await statusAgentctl(config))
    return
  }

  if (command === 'run') {
    await runAgentctl(config)
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
