# araya

CLIコマンド: `araya`。

**実験用MVP** + **pi機能利用ランチャー**。

- `araya tick/status/run` で自作control planeを操作
- `araya` だけで **piの機能を利用**してCodex/Claudeセッションを開始（piのログイン状態をそのまま活用）

## 使い方

```sh
araya              # piの機能を利用してセッション開始（推奨）
araya tick
araya status
araya run
araya approve <id>
araya reject <id>
```

これで `araya` コマンド1つで、piの機能を活用した常時動作セッションと自作ツールを両方扱えます。
