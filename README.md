# araya

**実験用 MVP**。利用者がJSONL inboxに書いた `development` 課題を、Araya の今の経路（inbox と `tick` / `run`）は実行せず、次のdue tickで `blocked` にします。SHIKI（開発のagent）は、Task の台帳と常駐する runner から動かす形に作り直しており、実装中です（仕様: [docs/spec/task-ledger-and-shiki-runner.md](docs/spec/task-ledger-and-shiki-runner.md)）。Araya自身はcommit・push・PR・merge・deployを行いません。自律的な課題発見、Goal / 探索対象の設定、外部ソース監視、read-only/external候補のexecutor、Native Broker、Discord/Hermes連携、Outbox配信、systemd常駐化は未実装です。`run`を起動しても、新しい課題を自律的に発見するわけではありません。引数なしの `araya` と `araya pi` は `@earendil-works/pi-coding-agent` のCLI entry pointを同じNode.jsプロセス内で実行し、その動作・権限・副作用はPi側の設定に従います。別途 `pi` CLIをインストールする必要はありません。

## 必要環境

- Node.js 24 以上
- Pi coding-agent SDK 1.4.0 は依存関係として含まれます。引数なしの `araya` または `araya pi` に、グローバルな `pi` コマンドは不要です。

```sh
npm ci
npm test
npm run typecheck
```

## 試す

```sh
export ARAYA_DATA_DIR="$HOME/.local/state/araya-demo"
npm run araya -- init
npm run araya -- tick
npm run araya -- status
```

`init` は初期状態と `inbox/seed.jsonl` を作ります。seed が既にあれば上書きしません。`tick` は due goal を一度処理し、`status` は保留中の durable task を再開せずに control plane と Pi Durable の状態を表示します。データは既定で `~/.araya` に置かれます。

継続起動を手動で試す場合は `npm run araya -- run` を使い、ARAYA_INTERVAL_MS ごとに tick が回り、Ctrl+C で止めます。引数なしの `araya` は Pi の interactive TUI を同じ Node.js プロセス内で起動しますが、Araya の `tick` は自動実行しません。制御 plane を明示的に起動する場合は `araya tick`、ヘルプ表示は `araya --help` を使います。`araya pi [arguments...]` は指定した引数を Pi coding-agent SDK の CLI entry point に渡します。`run` は前景プロセスの loop であり、OS 起動時の自動起動・監視・再起動を設定しません。次回起床時刻は control plane DB に保存されますが、長期停止後の復旧・重複実行を含む採用条件はまだ検証完了していません。

初期 seed を処理したときの状態遷移は次のとおりです。

- executor がない `read-only` 候補: `blocked` (`no_read_only_executor`)
- `external` 候補: `approval_requested`
- `approve <opportunityId>` 後: 次の処理で `blocked` (`no_external_executor`)
- 承認通知用 outbox: `pending` のまま。送信処理はありません。

`tick` の `due` は「処理時刻が来て tick を実行した」という意味で、候補が実行・完了した保証ではありません。

## inbox 形式

`ARAYA_INBOX_DIR` 配下の `.jsonl` ファイルを読みます。各行は JSON object です。通常候補の例:

```json
{"id":"candidate:example","kind":"investigate","title":"対象の状態を確認する","risk":"read-only","payload":{"source":"local-note"}}
```

開発課題の例:

```json
{"id":"development:example","kind":"development","title":"入力検証を追加する","risk":"workspace","payload":{"task":"araya の入力で空の値を拒否し、既存のテストに回帰ケースを追加する"}}
```

`development` 行の取り込みでは形を検証します。`payload` は `task` だけを持ちます（空白以外の文字を含む20,000文字以内、NULなし）。`task` 以外のkeyを持つ課題はintakeで拒否します。

取り込んだ `development` 課題は、今は実行しません。次のdue tickでArayaは、agentもモデルも起動せずに課題を `blocked`（evidence の `type` は `development_executor_unavailable`）にします。worktreeの作成、差分の収集、検証コマンドの実行も行いません。開発課題を実行する経路は、Task の台帳と runner として実装中です。

`risk` は `read-only`、`workspace`、`external` のいずれかです。`workspace` は `kind: "development"` 専用です。`id` は省略可能ですが、再投入時の重複防止には安定した ID を指定してください。不正行・重複 ID・読み取りエラーは `inbox.read_errors` event に記録します。不正な行は候補に含めず、同じ読み込みで有効だった行は処理対象になることがあります。そのため `tick` の `due` は入力全件が正常だった保証ではありません。inboxの内容はデータとして扱います。`development` の `payload.task` も、今は実行されません。

## CLI

```sh
araya                                # Pi の interactive TUI を同一プロセス内で起動（tick は自動では実行しない）
araya pi [arguments...]              # 指定した引数を Pi coding-agent SDK に転送
araya --help                         # ヘルプ表示
npm run araya -- init
npm run araya -- tick
npm run araya -- status
npm run araya -- run
npm run araya -- pi [arguments...]
npm run araya -- approve <opportunityId> [note...]
npm run araya -- reject <opportunityId> [note...]
```

承認コマンドは判断を記録するだけで、外部操作を開始しません。

## 設定

- `ARAYA_DATA_DIR` — 状態ディレクトリ（既定: `~/.araya`）
- `ARAYA_INBOX_DIR` — JSONL inbox（既定: `<dataDir>/inbox`）
- `ARAYA_STATUS_FILE` — 状態スナップショット（既定: `<dataDir>/status.json`）
- `ARAYA_CONTROL_PLANE_PATH` — Goal / Opportunity / decision / event / outbox DB
- `ARAYA_PI_DURABLE_PATH` — Pi Durable task graph DB
- `ARAYA_INTERVAL_MS` — 次回起床間隔（既定: 900000 ms）
- `ARAYA_MAX_ACTIONS` — 1 tick あたりの処理候補数上限（既定: 3）
- `ARAYA_DEV_ROOT` — 開発root（既定: `~/dev`）。runner（実装中）で使います。今の経路は `development` 課題を実行しないため使いません。
- `ARAYA_DEVELOPMENT_TIMEOUT_MS` — 開発agent 1回のtimeout（既定: 1200000 ms、範囲: 1000〜3600000 ms）。runner（実装中）で使い、今の経路では使いません。範囲外の値は範囲に丸め、数でない値は既定値にします。
- `ARAYA_VERIFICATION_TIMEOUT_MS` — 検証command 1件ごとのtimeout（既定: 300000 ms、範囲: 1000〜3600000 ms）。runner（実装中）で使い、今の経路では使いません。範囲外の値は範囲に丸め、数でない値は既定値にします。
- `PI_CODING_AGENT_DIR` — Pi の agent directory。Pi と Araya の両方で同じ値を使うと、`tick` / `run` のモデルruntimeが Pi と同じ `auth.json` と `models.json` を参照します（`tick` / `run` はモデルを呼び出しません）。runner（実装中）の SHIKI も同じ directory を使う予定です。未指定時は `~/.pi/agent` を使用します。

### 設定ファイル

設定ファイル `<dataDir>/config.json`（既定: `~/.araya/config.json`）は、runner（実装中）で SHIKI の model と thinking level を選ぶための設定です。今の経路は `development` 課題を実行しないため、指定した model は使われません。場所は `ARAYA_DATA_DIR` に従い、設定ファイルの場所だけを変える環境変数はありません。

```json
{
  "development": {
    "model": "openai/gpt-5.5",
    "thinkingLevel": "high"
  }
}
```

- 形式は UTF-8 の JSON object で、64 KiB まで。top level の key は `development`（省略可）だけです。`{}` やファイルが無い場合は、Pi の設定（`settings.json` の `defaultProvider`・`defaultModel` など）で model を選ぶ想定です。
- `development.model`（必須）: `<provider>/<model id>`。最初の `/` で provider と model id に分けるため、model id には `/` を含められます（例: `openrouter/moonshotai/kimi-k2.6`）。provider と model id は空にできず、空白と制御文字を含めず、全体で200文字まで。
- `development.thinkingLevel`（省略可）: `off`・`minimal`・`low`・`medium`・`high`・`xhigh`・`max` のいずれか。省略すると Pi の設定（`modelThinkingLevels["<provider>/<id>"]` → `defaultThinkingLevel` → `medium`）で決まります。Pi は model が対応しない thinking level を対応する値に丸めます。
- 知らない key、型の違う値、`null` は拒否します。ファイルが存在するのに使えない場合（JSON の誤り、schema 違反、64 KiB 超、UTF-8 でない、通常の file でない、壊れた symlink、読めない）は、`init`・`tick`・`status`・`run`・`approve`・`reject` が何も処理せずに `invalid Araya config file <path>: <理由>` で失敗します（exit code 1）。引数なしの `araya`・`araya pi`・`araya --help` は設定ファイルを読みません。
- 設定ファイルは subcommand の起動時に1回だけ読みます。`araya run` の実行中に書き換えた内容は、再起動するまで反映されません。
- `araya status` の出力と `status.json` の `config` に、`configPath` と `developmentModel`（`{ "model": "<provider>/<id>", "thinkingLevel": ... }`、未指定なら `null`）が入ります。status は Pi の認証を読まないため、model が実際に使えるかは表示しません。
- 利用上限に達したときの fallback model と自動 retry は未対応です。`fallbackModels` などの key は知らない key として拒否します。

詳細は [docs/spec/development-model-config.md](docs/spec/development-model-config.md) を参照してください。

## 状態と安全境界

- `araya.sqlite` が Goal、Opportunity、承認、Event、Outbox を保持します。
- `pi-durable.sqlite` が Pi Durable の Task Graph と Checkpoint を保持します。Pi Durable 1.4.0 で既存DBを開くと schema v2 へ自動移行されます。移行後は同じDBを Pi Durable 1.3.0 以下で開けないため、初回利用前にDBをバックアップしてください。
- 2つの SQLite DB をまたぐ単一 transaction はありません。現在の PoC では、SQLite 間の障害注入・クラッシュ復旧の条件を満たしたとは主張しません。
- `read-only` / `external` の実行executorがない候補は `completed` と偽らず、`blocked` として残します。
- Arayaの通常control-plane処理は外部書き込みや通知送信をしません。`tick` / `run` は、Pi Durable の harness を開くときに Pi のモデルruntimeを作りますが、モデルは呼び出しません。Piの認証情報は `PI_CODING_AGENT_DIR`（未指定時は `~/.pi/agent`）から読み取り、Arayaの設定やDBには複製しません。引数なしの `araya` と `araya pi` は明示的にPi coding-agent SDKのCLI entry pointを実行するため、その実行はこの節の対象外です。
- `development` 課題は実行せず `blocked` として残します（`development_executor_unavailable`）。
- DB や inbox に利用者のデータを置く場合は、`ARAYA_DATA_DIR` とバックアップのアクセス権を利用者側で管理してください。

## グローバルインストール

ルートで `npm run deploy` を実行すると、`araya`（version `0.0.1`）をbuildし、一時tarballからユーザーglobal prefix（既定: `$HOME/.local`）へinstallします。checkoutへのsymlinkではないため、以後のソース変更は再deployまで反映されず、worktreeを移動・削除してもinstall済みコマンドは影響を受けません。npm registryへのpublishは行いません。指定prefix内に旧 `agentctl` package があれば先にuninstallし、`araya` のbin競合を解消してから置き換えます。

```sh
npm run deploy
araya --help
```

別のprefixを使う場合は `ARAYA_INSTALL_PREFIX` で上書きできます。prefixの `bin` directoryが `PATH` に含まれていることを確認してください。

```sh
ARAYA_INSTALL_PREFIX="$HOME/.npm-global" npm run deploy
```

## 開発

```sh
npm test
npm run typecheck
```

テストは一時ディレクトリを使い、実際の SQLite と Pi Durable storage を通して状態遷移を検証します。
