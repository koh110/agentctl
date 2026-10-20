# araya

**実験用 MVP**。長期 Goal（現状は固定の `常時 scout` placeholder）と定期起床、JSONL inbox の永続取り込み、候補の承認状態をローカルで扱うための単一 Node.js package です。

現在の実装は「常時動作する自律探索」の完成版ではありません。利用者が設定できる Goal / 探索対象はなく、候補の入力は利用者が置く JSONL に限られます。LLM による新しい Research Question の発見、外部ソース監視、実作業 executor、Native Broker、Discord/Hermes 連携、Outbox 配信、systemd 常駐化は未実装です。したがって、`run` を起動しても価値ある作業を自律的に発見・完遂するわけではありません。

## 必要環境

- Node.js 24 以上

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

`init` は初期状態と `inbox/seed.jsonl` を作ります。seed が既にあれば上書きしません。`tick` は due goal を一度処理し、`status` は control plane と Pi Durable の状態を表示します。データは既定で `~/.araya` に置かれます。

継続起動を手動で試す場合は `araya` を引数なしで実行する（`npm run araya -- run` でも同義）と、ARAYA_INTERVAL_MS ごとに tick が回り、Ctrl+C で止めます。引数なしの `araya` は `run` と同じです。これは前景プロセスの loop であり、OS 起動時の自動起動・監視・再起動を設定しません。次回起床時刻は control plane DB に保存されますが、長期停止後の復旧・重複実行を含む採用条件はまだ検証完了していません。

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
araya                                # 引数なし: 常時起動（run と同じ）
npm run araya -- init
npm run araya -- tick
npm run araya -- status
npm run araya -- run
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

## 状態と安全境界

- `araya.sqlite` が Goal、Opportunity、承認、Event、Outbox を保持します。
- `pi-durable.sqlite` が Pi Durable の Task Graph と Checkpoint を保持します。
- 2つの SQLite DB をまたぐ単一 transaction はありません。現在の PoC では、SQLite 間の障害注入・クラッシュ復旧の条件を満たしたとは主張しません。
- 実行 executor がない候補を `completed` と偽らず、`blocked` として残します。
- 外部書き込み、モデル呼び出し、ネットワーク接続、通知送信は行いません。
- DB や inbox に利用者のデータを置く場合は、`ARAYA_DATA_DIR` とバックアップのアクセス権を利用者側で管理してください。

## 開発

```sh
npm test
npm run typecheck
```

テストは一時ディレクトリを使い、実際の SQLite と Pi Durable storage を通して状態遷移を検証します。
