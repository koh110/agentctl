# araya

CLIコマンド: `araya`。

**実験用MVP** + **Hermes Agentランチャー**。

- `araya tick` / `status` / `run` で自作のcontrol planeを操作
- `araya hermes` で **piと同じように** Hermes Agentのインタラクティブセッションを開始

## インストール

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
araya init          # 初期化
araya tick          # 自作control planeを1回処理
araya status        # 状態確認
araya run           # 自作control planeを常時実行

araya hermes        # ← これでpiと同じようにHermes Agentセッション開始
araya hermes -q "今日の予定を整理して"
```

データは常に `~/.araya` に保存されます。環境変数は使いません。

## hermesサブコマンドについて

`araya hermes` は `hermes chat` を直接呼び出します。
- 引数なし → インタラクティブセッション（piと同じ体験）
- `-q "質問"` → 一発クエリ実行
- その他すべてのHermesフラグ（`--model`, `--profile`, `-s skill` など）がそのまま使えます

これで `araya` だけでHermesの常時動作セッションも開始できます。
