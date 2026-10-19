# araya

CLIコマンド: `araya`。

**実験用 MVP**。ローカルでJSONL inboxを取り込み、候補の承認状態を管理するシンプルなツールです。

現在は自律探索は未実装です。ユーザーが `inbox/` にJSONLを置いて `araya tick` を実行する形です。

## インストール（このホスト用）

```sh
cd /home/koh110/dev/agentctl/.worktree/araya-cli
npm ci --ignore-scripts

pack_dir="$(mktemp -d)"
npm pack --workspace=packages/agentctl --pack-destination "$pack_dir"
npm install --global --prefix "$HOME/.local" --ignore-scripts --no-audit --no-fund "$pack_dir/agentctl-0.1.0.tgz"
rm -rf "$pack_dir"

export PATH="$HOME/.local/bin:$PATH"
araya --help
```

## 使い方

```sh
araya init          # 初期化（~/.araya を作成）
araya tick          # 1回処理を実行
araya status        # 現在の状態を表示
araya run           # フォアグラウンドで定期実行（Ctrl+Cで停止）
```

データはすべて `~/.araya` に保存されます。環境変数は使いません。

## inbox の形式

`~/.araya/inbox/` 以下に `.jsonl` ファイルを置きます。

```json
{"id":"candidate:example","kind":"investigate","title":"対象を確認する","risk":"read-only","payload":{"source":"local-note"}}
```

`risk` は `read-only` または `external` のみ有効です。

## 開発

```sh
npm test
npm run typecheck
npm run build
```

これでシンプルになりました。
