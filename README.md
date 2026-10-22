# araya

**実験用 MVP**。長期 Goal（現状は固定の `常時 scout` placeholder）と定期起床、JSONL inbox の永続取り込み、候補の承認状態をローカルで扱うための単一 Node.js package です。

Araya の control plane は「常時動作する自律探索」の完成版ではありません。利用者が設定できる Goal / 探索対象はなく、候補の入力は利用者が置く JSONL に限られます。LLM による新しい Research Question の発見、外部ソース監視、実作業 executor、Native Broker、Discord/Hermes 連携、Outbox 配信、systemd 常駐化は未実装です。したがって、`run` を起動しても価値ある作業を自律的に発見・完遂するわけではありません。引数なしの `araya` と `araya pi` は `@earendil-works/pi-coding-agent` の CLI entry point を同じ Node.js プロセス内で実行し、その動作・権限・副作用は Pi 側の設定に従います。別途 `pi` CLI をインストールする必要はありません。

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

`ARAYA_INBOX_DIR` 配下の `.jsonl` ファイルを読みます。各行は JSON object で、例:

```json
{"id":"candidate:example","kind":"investigate","title":"対象の状態を確認する","risk":"read-only","payload":{"source":"local-note"}}
```

`risk` は `read-only` または `external`。`id` は省略可能ですが、再投入時の重複防止には安定した ID を指定してください。不正行・重複 ID・読み取りエラーは `inbox.read_errors` event に記録します。不正な行は候補に含めず、同じ読み込みで有効だった行は処理対象になることがあります。そのため `tick` の `due` は入力全件が正常だった保証ではありません。inbox の内容はデータとして扱い、実行可能な指示としては解釈しません。

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
- `PI_CODING_AGENT_DIR` — Pi の agent directory。Pi と Araya の両方で同じ値を使うと、`tick` / `run` のモデルruntimeが同じ `auth.json` と `models.json` を参照します。未指定時はPiの既定directoryを使用します。

## 状態と安全境界

- `araya.sqlite` が Goal、Opportunity、承認、Event、Outbox を保持します。
- `pi-durable.sqlite` が Pi Durable の Task Graph と Checkpoint を保持します。Pi Durable 1.4.0 で既存DBを開くと schema v2 へ自動移行されます。移行後は同じDBを Pi Durable 1.3.0 以下で開けないため、初回利用前にDBをバックアップしてください。
- 2つの SQLite DB をまたぐ単一 transaction はありません。現在の PoC では、SQLite 間の障害注入・クラッシュ復旧の条件を満たしたとは主張しません。
- 実行 executor がない候補を `completed` と偽らず、`blocked` として残します。
- Araya の制御 plane コマンド自体は、外部書き込み、モデル呼び出し、ネットワーク接続、通知送信を行いません。`tick` / `run` の durable Harness は Pi の `ModelRuntime` を使い、別プロセスでも Pi の `/login` で保存した認証情報をモデルリクエスト時に解決できます（既定の agent directory を共有します。変更する場合は `PI_CODING_AGENT_DIR` を Pi と Araya の両方に設定してください）。認証情報は Araya の設定やDBへ複製しません。現状の scout/work task はまだモデルを呼び出さないため、tick自体がLLM処理を行うものではありません。引数なしの `araya` と `araya pi` は明示的に Pi coding-agent SDK の CLI entry point を実行するため、その実行はこの制約の対象外です。
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
