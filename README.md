# try-pi-agent

Pi agentを使ってみる試みです。

## セットアップ

`mise` が有効なシェルで、次を実行します。

```sh
mise install
pi
```

`.pi/settings.json` にプロジェクト用の sandbox extension を登録しています。初回起動時に、Pi が `.pi/npm/` へ extension の依存パッケージをインストールします。

通常のシェルで `pi` を直接実行したい場合は、`mise activate` をシェルへ設定してください。

```sh
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc
```

## Sandbox

利用している `pi-sandbox` は、bash の実行を macOS の `sandbox-exec`（Linux では `bubblewrap`）で制限し、ファイルの read/write/edit とネットワークアクセスを必要に応じて確認します。

プロジェクトの設定は `.pi/sandbox.json` です。sandbox を一時的に無効にする場合は、次を使います。

```sh
pi --no-sandbox
```

macOS または Linux では `rg`（ripgrep）が必要です。このPJでは `mise install` が `rg` も導入します。`mise` の外で使う場合は、macOS では次のコマンドでも導入できます。

```sh
brew install ripgrep
```

## WorktreeセッションExtension

`.pi/extensions/worktree-session.ts` に、実験用のExtensionを置いています。

できること：

- `/worktree <目的>`：目的をLLMに渡し、Conventional Branch形式の名前を生成してworktreeを作成します。
- 作成したworktreeへ、会話履歴を引き継いだままPiセッションを切り替えます。
- `create_worktree`：LLMから呼び出せるworktree作成ツールです。
- フッターに現在のworktree名とbranch名を表示します。

`<目的>`は自然言語で書けます。例えば：

```text
/worktree パスキーログインを作る
```

LLMが`feat/auth-add-passkey-login`のようなbranch名を考え、確認後に作成・切り替えます。

最初の動作確認では、作成したworktree側でもExtensionを使えるよう、明示的に読み込みます：

```sh
pi --approve --no-extensions -e ./.pi/extensions/worktree-session.ts
```
