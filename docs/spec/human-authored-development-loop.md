# 人が投入する開発課題を処理する自動ループ

## 概要

Araya の利用者がJSONL inboxに具体的な開発課題を書くことが実行開始の承認となる。別のapprove操作は不要。Araya は due tick で課題を選び、Pi coding-agent SDKを使って専用Git worktree内で実装し、隔離環境で指定された検証コマンドを実行する。結果はworktree/branch・差分・検証結果として保存し、base branch、remote、commit、PR、deployは変更しない。

## 入力契約

開発候補は次の形式とする。

```json
{"id":"development:example","kind":"development","title":"入力検証を追加する","risk":"workspace","payload":{"task":"...具体的な作業と期待結果...","verifyCommand":["npm","test"]}}
```

- `risk: "workspace"` は、Araya が新規ローカルworktree内のコードを編集してよいことを意味する。
- `payload.task` は必須。文字数・NUL byteを検証し、上限を設ける。
- `payload.verifyCommand` は空でない argv 配列を必須とし、shell文字列として解釈しない。
- 開発以外の `read-only` / `external` 候補の既存挙動を保つ。既存 `external` 候補は従来どおり人間承認を要求する。
- JSONL、task、repository内容はmodelへの入力データとして扱い、Pi tool API以外の権限を付与しない。

## 開発実行

- `ARAYA_PROJECT_DIR` は対象Git repositoryの場所。未指定時は起動時のcurrent directoryからGit rootを解決する。
- `ARAYA_WORKTREE_DIR` はworktree保存先。未指定時はAraya data directory配下とする。
- source repositoryにtracked/untracked変更がある場合は、base snapshotの曖昧さを避けるため開始せず拒否する。
- cleanなHEADから課題ごとの一意なlocal branchとworktreeを作る。worktree作成前のHEAD OIDを証拠として保存する。
- Pi 1.4 SDKのAgentSessionをnon-interactiveに使い、tool allowlistはAraya管理のworkspace限定read/list/search/edit/write toolsのみ。bash/PowerShell、MCP、外部extensionを有効にしない。sessionはin-memoryとし、会話履歴をPiの通常session directoryへ保存しない。Pi agent directoryはread-onlyでmountし、モデル通信に必要なnetworkだけworkerの実行環境で共有する。
- file toolsはroot外の絶対path、`..`、root外へ向かうsymlink、hardlinkを拒否する。`.git` metadataと`node_modules`はmodelから不可視にする。
- verify commandはbubblewrap内でshellなしargvとして実行する。home/credential directoryとGit metadataはnamespaceに含めず、networkをunshareする。worktreeは一時overlayから参照し、verification中のworkspace書き込みは終了時に破棄する。一時tmpfsもwrite可能、system runtimeと既存依存はread-onlyとする。system configは最小限の必要ファイルだけをmountし、host secret fileは含めない。
- worktree rootは利用者の所有を要求し、symlinkを含むpath、全ユーザーが書き込めるworktree root、全ユーザーが書き込めてstickyでない親directoryを拒否する。umask 002の既定mode（775）でも動くよう、group書き込みは許可する。
- task単位のtimeoutとstdout/stderr上限を設ける。timeout/失敗時はtaskをfailedにし、既存worktreeを削除せず証拠として残す。自動retryはしない。
- 各tickのworkspace taskは最大1件。複数taskを並列実行しない。

## 完了・失敗

- model sessionが正常に終了し、差分があり、指定verify commandがexit 0の場合に `completed` とする。
- model error、timeout、空差分、verify command不在/不正/timeout/non-zeroは成功扱いしない。taskを `failed` にし、失敗理由とworktree/branchを保存する。
- opportunity evidenceへbase SHA、worktree path、branch、変更ファイル/diff stat、model summary、verify argv/exit status/制限済み出力を記録する。
- どの結果でもArayaはcommit、push、PR、merge、deployを自動実行しない。

## 技術調査結果

- Pi coding-agent 1.4.0 の `createAgentSession` は `ModelRuntime`、custom tools、明示的tool allowlist、resource loader、session managerを受け取れる。`SessionManager.inMemory()` と `AgentSession.sendUserMessage()` / `waitForIdle()` / `abort()` が利用可能。
- Pi標準のfile toolsはabsolute pathを受け入れ、cwdをfilesystem jailとして強制しない。標準toolsのまま自律実行せず、Arayaがroot-check付きcustom operationsを提供する。
- このhostのbubblewrap probeでは、`--unshare-all` namespace内からHOME配下を不可視にし、作業dirだけwrite可能、外部home pathへのwriteを拒否できた。
- Pi 1.4 のSQLite Durable migrationは別のDBに適用される。Araya control-plane schema migrationは専用scratch DBだけで検証し、既存の利用者DBでは試さない。

## Out of scope

- Araya自身による課題の発見・優先順位付け、GitHub Issue同期
- 複数開発taskの同時実行、自律retry
- 自動commit/push/PR/merge/deploy、main/baseへの変更
- modelへ任意shell、MCP、任意Pi extensionsを許可すること
- 実ユーザーのPi auth/APIを使った開発taskのE2E検証

## Acceptance Criteria

- [ ] development taskをJSONLから厳格にvalidateし、workspace risk以外では受理しない。
- [ ] control-plane schema migrationが旧DBの全既存行・参照関係を保持し、workspace riskを許可する。scratch DBで旧schema→新schemaを検証する。
- [ ] `tick` / `run` はworkspace taskを一度だけ隔離worktreeで実行し、通常のexternal/read-only挙動を維持する。
- [ ] root外path、絶対path escape、`..`、外部symlinkをfile toolsが拒否する。
- [ ] coding agentにshell/MCP/extensionsが公開されない。test commandはbubblewrapでhome不可視・networkなしで実行する。
- [ ] clean base、task branch/worktree、model session、verify commandの各失敗条件でmain branchが変更されず、正確なfailure evidenceが残る。
- [ ] 成功/失敗の双方でworktree/branchが保持され、Arayaがcommit/push/merge/deployを実行しない。
- [ ] 外部Pi authまたはmodel APIを使わずにunit/integration testsを実行する。
