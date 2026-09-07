# try-pi-agent

Pi agentを使ってみる試みです。

## セットアップ

`mise` が有効なシェルで、次を実行します。

```sh
mise install
mise exec -- pi
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
mise exec -- pi --no-sandbox
```

macOS または Linux では `rg`（ripgrep）が必要です。このPJでは `mise install` が `rg` も導入します。`mise` の外で使う場合は、macOS では次のコマンドでも導入できます。

```sh
brew install ripgrep
```
