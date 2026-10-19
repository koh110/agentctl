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
    フォアグラウンドで定期実行（Ctrl+C で停止）。

  araya approve <opportunityId> [note...]
    承認待ち候補を承認する。

  araya reject <opportunityId> [note...]
    候補を却下する。

  araya
    何も指定しないと pi のように Codex / Claude セッションを起動（ログイン状態を引き継ぐ）。

環境変数は使いません。データは常に ~/.araya です。
`)
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

async function main(): Promise<void> {
  const { help, positionals } = parseCliArguments(process.argv.slice(2))
  const command = positionals[0] ?? 'chat'

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

  // デフォルト（araya だけ、または araya chat）は pi のように Codex/Claude セッションを起動
  if (command === 'chat' || positionals.length === 0) {
    const spawn = await import('child_process')
    const remainingArgs = process.argv.slice(3) // -q, --model などをそのまま渡す

    console.log('🚀 araya → Codex / Claude セッションを起動します (piと同じログイン状態)...')
    if (remainingArgs.length > 0) {
      console.log(`codex ${remainingArgs.join(' ')}\n`)
      const proc = spawn.spawn('codex', remainingArgs, { stdio: 'inherit', shell: false })
      proc.on('exit', (code) => { process.exitCode = code ?? 0 })
    } else {
      console.log('codex\n')
      const proc = spawn.spawn('codex', [], { stdio: 'inherit', shell: false })
      proc.on('exit', (code) => { process.exitCode = code ?? 0 })
    }
    return
  }

  printHelp()
  throw new Error(`不明な command: ${command}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
