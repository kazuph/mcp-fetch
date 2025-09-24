# Contributing

## 開発ルール（必読）
- main（マスター）へ「直接 push」しないこと。必ず Pull Request（PR）で変更を取り込みます。
- 変更はトピックブランチで行い、命名は `feat/*`, `fix/*`, `chore/*`, `release/*` などを推奨します。
- リリース作業は以下のフローに従います。
  1. バージョンを `package.json` とサーバーメタ（`index.ts` 内の `version`）で更新
  2. `RELEASE_NOTES_vX.Y.Z.md` を追加
  3. ブランチ名 `release/vX.Y.Z` を作成し、コミット・push
  4. PR を作成（base: `main`, head: `release/vX.Y.Z`）
  5. CI が通過後にレビューを経て `main` へマージ
  6. `main` へマージされたときのみ、GitHub Actions が npm へ publish（既に公開済みのバージョンは自動スキップ）
- 直接タグ push による公開は行いません（`publish.yml` は `push` to `main` でのみ発火）。
- PR が `main` にマージされると、以下が自動実行されます：
  - npm publish（未公開バージョンのみ）
  - タグ作成と GitHub Releases の発行（未作成のときのみ）
- コミットメッセージは Conventional Commits を推奨（例: `fix: correct image fetch default`）。
- テスト方針：`npm test` は unit → typecheck → format → biome を通過する必要があります。
- テストでローカル HTTP サーバを用いるため、以下の環境変数でサーバ起動や SSRF ガードを無効化します（本番では設定しないこと）。
  - `MCP_FETCH_DISABLE_SERVER=1`
  - `MCP_FETCH_DISABLE_SSRF_GUARD=1`

## PR テンプレ
- 目的 / 背景
- 変更点（ユーザー影響 / 互換性）
- セキュリティ観点（ネットワーク/ファイルI/O 等の変更があれば明記）
- 動作確認（スクショ/ログ/テスト結果）
- リリースノート（必要に応じて）
