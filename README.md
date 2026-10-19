# araya

CLIコマンド: `araya`。

**実験用MVP** + **pi機能利用ランチャー**。

- `araya tick/status/run` で自作control planeを操作
- `araya` だけで **piの機能を利用**してCodex/Claudeセッションを開始（piのログイン状態を活用）

**注意**: `pi` コマンドがグローバルにインストールされている必要があります。

## 使い方

```sh
araya              # piの機能を利用してセッション開始
araya tick
araya status
araya run
```

データは常に `~/.araya` です。
