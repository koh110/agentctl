# araya

CLIコマンド: `araya`。

**実験用MVP** + **pi互換ランチャー**。

- `araya tick` / `status` / `run` で自作control plane操作
- `araya` だけで **piと同じように** Codex / Claude セッションを起動（ログイン状態を引き継ぐ）

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
araya              # ← これだけで pi のように Codex/Claude セッション開始
araya -q "質問"    # 一発クエリ（codex -q "質問" と同等）
araya tick         # 自作control planeを1回処理
araya status
araya run
araya approve <id>
araya reject <id>
```

データは常に `~/.araya` に保存されます。環境変数は使いません。

これで `araya` コマンド1つで、piと同じログイン体験のAIセッションと自作ツールの両方を起動できます。
