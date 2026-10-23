# araya

**実験用 MVP**。利用者がJSONL inboxに書いた `development` 課題を、Araya は due tick で1件選び、Pi coding-agent SDKのagentを開発root（既定: `~/dev`）でsandboxなしに動かします。agentは課題に必要なrepositoryを自分で判断し（複数でもよい）、変更するrepositoryごとに `<repository>/.worktree/` 配下へ課題用のworktreeを作って実装し、最終状態で通るべき検証コマンドを登録します。agentの終了後、Arayaは登録された検証コマンドを各worktreeで実行し、worktreeごとのbase SHA、branch、差分、検証結果を保存して停止します。Araya自身はcommit・push・PR・merge・deployを行いません。自律的な課題発見、Goal / 探索対象の設定、外部ソース監視、read-only/external候補のexecutor、Native Broker、Discord/Hermes連携、Outbox配信、systemd常駐化は未実装です。`run`を起動しても、新しい課題を自律的に発見するわけではありません。引数なしの `araya` と `araya pi` は `@earendil-works/pi-coding-agent` のCLI entry pointを同じNode.jsプロセス内で実行し、その動作・権限・副作用はPi側の設定に従います。別途 `pi` CLIをインストールする必要はありません。

## 必要環境

- Node.js 24 以上
- Git。`development` 課題で worktree の作成と差分の収集に使います（`/usr/bin/git`、`/bin/git`、`/usr/local/bin/git` のいずれか）。
- Windows 以外の OS。agent と検証コマンドを process group 単位で止めるためです。
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
{"id":"development:example","kind":"development","title":"入力検証を追加する","risk":"workspace","payload":{"task":"agentctl の入力で空の値を拒否し、既存のテストに回帰ケースを追加する"}}
```

`development` 行をinboxへ置くことが実行開始の承認です。別のapprove操作は不要です。`payload` は `task` だけを持ちます（空白以外の文字を含む20,000文字以内、NULなし）。`task` 以外のkeyを持つ課題はintakeで拒否します。課題ごとの検証コマンドは指定できません。

次のdue tickでArayaは次のように処理します。

1. 課題ごとの状態directory `<dataDir>/development/<taskKey>/` を作り、Pi agentを開発rootで起動します。`taskKey` は `development-` と opportunity id の SHA-256 の先頭20桁です。状態directoryが既にある課題は実行せず、以前のworktreeやbranchを再利用しません。
2. agentは課題に必要なrepositoryを判断し、変更するrepositoryごとに `araya_create_worktree` で `<repository>/.worktree/araya-<taskKey>` にworktreeとbranch `araya/<taskKey>` を作って、その中だけを編集します。`.worktree` がignoreされていないrepositoryでは、`.git/info/exclude` に `/.worktree/` を1行追記します。
3. agentは終了前に、変更したworktreeごとに最終状態で通るべき検証コマンドを `araya_register_verification` で登録します。
4. agentの終了後、Arayaは差分のあるworktreeごとに、登録された検証コマンドをshellなしのargvとして登録順に実行します。差分のあるworktreeすべてに検証が登録され、すべてexit 0のときだけ `completed` とします。それ以外は理由（`no_changes`、`verification_missing`、`verification_failed`、`agent_failed`、`agent_timeout` など）を付けて `failed` とします。

完了・失敗いずれでもworktreeとbranchを保持し、worktreeごとの差分（base SHAとの差。commit済み・未commit・untrackedを含む、全worktree合計で256 KiBまで）と、検証ごとのstdout/stderrの末尾8 KiBを証拠として保存します。

`risk` は `read-only`、`workspace`、`external` のいずれかです。`workspace` は `kind: "development"` 専用です。`id` は省略可能ですが、再投入時の重複防止には安定した ID を指定してください。不正行・重複 ID・読み取りエラーは `inbox.read_errors` event に記録します。不正な行は候補に含めず、同じ読み込みで有効だった行は処理対象になることがあります。そのため `tick` の `due` は入力全件が正常だった保証ではありません。inboxの内容はデータとして扱いますが、`development` の `payload.task` はPiへの指示として実行されます。人が内容を確認してから書き込んでください。

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
- `ARAYA_DEV_ROOT` — 開発root（既定: `~/dev`）。agentはここをcwdとして動き、配下のrepositoryのcloneを使います。課題の開始時にrealpathで解決し、directoryでなければ課題は `dev_root_missing` で失敗します。
- `ARAYA_DEVELOPMENT_TIMEOUT_MS` — agent 1回のtimeout（既定: 1200000 ms、範囲: 1000〜3600000 ms）。timeoutではworkerにSIGTERMを送ってPi sessionをabortさせ、10秒で終わらなければSIGKILLを送ります。
- `ARAYA_VERIFICATION_TIMEOUT_MS` — 検証command 1件ごとのtimeout（既定: 300000 ms、範囲: 1000〜3600000 ms）
- `PI_CODING_AGENT_DIR` — Pi の agent directory。Pi と Araya の両方で同じ値を使うと、`tick` / `run` のモデルruntimeと開発agentが同じ `auth.json` と `models.json` を参照します。未指定時は `~/.pi/agent` を使用します。

## 状態と安全境界

- `araya.sqlite` が Goal、Opportunity、承認、Event、Outbox を保持します。
- `pi-durable.sqlite` が Pi Durable の Task Graph と Checkpoint を保持します。Pi Durable 1.4.0 で既存DBを開くと schema v2 へ自動移行されます。移行後は同じDBを Pi Durable 1.3.0 以下で開けないため、初回利用前にDBをバックアップしてください。
- 2つの SQLite DB をまたぐ単一 transaction はありません。現在の PoC では、SQLite 間の障害注入・クラッシュ復旧の条件を満たしたとは主張しません。
- `read-only` / `external` の実行executorがない候補は `completed` と偽らず、`blocked` として残します。
- Arayaの通常control-plane処理は外部書き込みや通知送信をしません。`tick` / `run` は `development` taskを実行するときだけPiのモデルruntimeを呼び出します。Piの認証情報は `PI_CODING_AGENT_DIR`（未指定時は `~/.pi/agent`）から読み取り、Arayaの設定やDBには複製しません。通常のscout処理やread-only/external候補はモデルを呼び出しません。引数なしの `araya` と `araya pi` は明示的にPi coding-agent SDKのCLI entry pointを実行するため、その実行はこの節の対象外です。
- `development` 課題のagentと検証commandはsandboxなしで動きます。Arayaを起動した利用者の権限・環境変数・networkをそのまま使い、開発root配下に限らずfilesystemを読み書きできます。agentのtoolはPi標準の `read`・`bash`・`edit`・`write`・`grep`・`find`・`ls` と、Arayaの `araya_create_worktree`・`araya_register_verification` の9種類で、sessionのtool集合がこれと一致しなければagentを動かしません。MCP、Pi extension、skill、prompt template、context fileは読み込まず、会話履歴はPiのsession directoryに保存しません。
- main checkoutを編集しない、commit・push・PR作成・merge・deploy・publishをしない、認証情報を読み出さない、といった制約はpromptでの指示だけで、Arayaは強制も検知もしません。課題の内容とagentの権限を理解したうえで課題を書いてください。
- 既知の制限: agentが `setsid` や `nohup` などで切り離したprocessは、timeout後も残ることがあります。検証commandはagentが登録するため、課題の作者が指定する方法はありません。worktreeとbranchは自動では削除しません。
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
