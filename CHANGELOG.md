# Changelog

## v1.2.19 - 2026-04-25

- **インストーラサイズを 159MB → ~80MB に半減 (約50%減)**
  - `next` (145MB) / `react-dom` (7MB) / `lucide-react` (6.5MB) / `react` を `dependencies` から `devDependencies` に移動
  - これらは `lp:dev` (ランディングページ用 Next.js) でのみ使用され、デスクトップアプリは一切 import していなかった
  - 結果: `resources/app/node_modules/` から ~160MB のデッドウェイトを削除
  - 自動アップデートで毎回ダウンロードする量も同じく半減

## v1.2.18 - 2026-04-25

- 自動アップデート後の "Cannot find module" 系起動失敗を根治
  - `nsis.runAfterFinish: false` を追加し、NSIS インストール直後の auto-launch を停止
  - 旧アプリの uninstall → 新ファイル書き込みが完了する前にアプリが起動して、まだコピーされていない依存モジュール (universalify / node-pty / ws / xlsx 等) を `require` しに行って失敗する競合状態を解消
  - インストール後はトレイ / スタートメニューから手動で起動する運用に変更

## v1.2.17 - 2026-04-25

- 設定タブ刷新の不具合修正 (v1.2.16 のフィードバック対応)
  - `Cannot set properties of null` エラーとフォーム空白問題を修正: rebuild が二重実行で1回目に moveした子を2回目に見失っていた → 完全に idempotent 化 (placeholder で原位置を保持し、wrap先を `unwrapPreviousShell` で戻してから再構築)
  - Excel取込ボタン (`入力テンプレート` / `Excelから読み込む`) もフォームと一緒に保持されるように
  - サイドバー / ヘッダ / ステッパー / フォームを **独立した白カード** として配置し、`--bg-base` の親背景でカード間に隙間を表現
  - 「設定のヒント」をフッタからサイドバー下部に移動 (写真リファレンス通り)
  - フォームカードを min-height 520px に拡張し、下部の白い無駄な余白を解消
  - サイドバーを sticky にしてスクロール時もメニューが追従

## v1.2.16 - 2026-04-25

- 設定タブを大幅刷新 (写真リファレンスに準拠)
  - サイドバー: アイコン + 名前 + 説明の2行レイアウト、アクティブ時はブルー強調
  - 上部に **進捗付きヘッダ** (「設定の完了率 X%」+ プログレスバー)
  - **5ステップのインジケータ** を追加 (会社プロフィール / 提供価値 / ターゲットリスト / メッセージテンプレート / 環境設定)
  - 会社プロフィールに **リアルタイム更新の右側プレビューパネル** を追加 (会社名・連絡先・会社概要)
  - フッタに「設定のヒント」+ **「保存して次へ」ボタン** を配置 (保存後に次のステップへ自動遷移)
  - 既存のフォーム ID / 保存ロジックは温存 (non-invasive な装飾オーバーレイ)

## v1.2.15 - 2026-04-25

- **MCP Playwright チェックを launch 時の必須から外す**
  - `/api/launch-ai` の前段で MCP 設定確認に失敗してもエラーにせず警告ログだけにする
  - Gemini / Codex の `mcp` サブコマンド未対応や偽陰性で起動できなかった問題を解消
  - バッチ送信パスでは引き続き MCP 必須 (`requireMcp: true` 経路は据え置き)
- **ターミナル高さをドラッグでリサイズ可能に**
  - `cli-term-host` 下端にドラッグハンドル(8px / `cursor: ns-resize`)
  - 200px〜画面の85% の範囲で自由調整、`localStorage('cli-term:height')` に永続化
  - リサイズ中は `fitAddon.fit()` を毎フレーム呼んで PTY サイズも追従

## v1.2.14 - 2026-04-25

- 内蔵ターミナルで「文字入力できない」「プロンプトが見切れる」問題を修正
  - 高さ 380px → 460px に拡張
  - クリックでターミナルを強制フォーカス、`cursor: text` で操作可能性を視覚化
  - フォーカス時に `outline: 1px solid` のリングを表示
  - `xterm-helper-textarea` の z-index を `-5` → `5` に上げて入力捕捉を確実化
  - 受信データのたび `scrollToBottom()` でプロンプトを常に視野内に保持
  - launch 後 40 / 120 / 360 / 800ms の 4 回 `fitAddon.fit()` を呼んで再レイアウトに耐える
  - `window.resize` 監視で再フィット

## v1.2.13 - 2026-04-25

- ページネーションバーの「表示件数」セレクトを画面右端から外し、ページ番号のすぐ右に寄せた左寄せレイアウトに変更
  - `justify-content: space-between` → `flex-start` / pages の `flex` を grow しない設定に
  - サマリ → ページ番号 → 表示件数セレクト の順で 18px gap でクラスタリング

## v1.2.12 - 2026-04-25

- 企業一覧 / 確認待ち / 送信済み / Action Log 全リストに **ページネーション** を追加
  - "Minimal SaaS" スタイル: 全件表示+ページ番号 (省略付き) + 表示件数セレクト
  - 表示件数は localStorage に永続化 (リスト単位)
  - フィルタで非表示の行は自動除外してページ計算
  - **10,000 件**まで耐えるパフォーマンス検証済み (注入 + ページング合計 1秒程度)
  - レスポンシブ対応 (760px 未満で縦並び)

## v1.2.11 - 2026-04-25

- CLI Activity タブに「**Claude を起動 / Codex を起動 / Gemini を起動**」ボタンと内蔵対話ターミナル (xterm.js) を追加
  - 既存 WebSocket (`/terminal`) + `/api/launch-ai` / `/api/stop-ai` / `/api/ai-input` と接続
  - PTY 出力をブラウザ内で表示、キーストロークも双方向
- 認証エラー(`Please run /login` / `API Error: 401` / `authentication_error` / `Invalid API key` / `token expired`) をリアルタイム検出すると、**手順入りの黄色アシストバナー** を自動表示
  - 「**/login を実行**」ボタンでターミナルに自動入力
  - 公式ドキュメントへのリンク併記
- 非エンジニアでもログイン作業ができるよう、空状態のヘルプ文言・ステータス LED・閉じるボタンを整備

## v1.2.10 - 2026-04-25

- `verify-release-readiness.cjs` を `nsis.differentialPackage: false` 時に blockmap 不存在を許容するよう修正 (v1.2.9 の Windows ビルド失敗対応)
- v1.2.9 は Windows 配布なし(Mac / Linux のみ)。実質的な内容は v1.2.10 と同じ

## v1.2.9 - 2026-04-25

- 自動更新の差分配信 (`differentialPackage`) を無効化し、毎回フルインストーラ転送に切り替え
  - 既存インストールが CI ビルドと完全一致していない場合に node_modules の transitive 依存 (universalify ほか) が脱落して `Cannot find module 'universalify'` で起動失敗する事故が v1.2.5→1.2.6 / 1.2.6→1.2.7 / 1.2.7→1.2.8 の 3 連続で発生したため、信頼性を優先
  - ダウンロード量は毎回 ~200MB に増えるが、自動更新の確実性が大きく改善

## v1.2.8 - 2026-04-25

- 「編集して再送」を実装 (送信済みカードのボタン → モーダル表示 → 編集 → POST /api/resend-prepare → 確認待ちタブへ復帰)
  - バックエンド `/api/resend-prepare` を追加 (action-log と contact-history を更新)
  - 検証: 空文 / 32KB 超 / 企業番号不正 を 400 で弾く
  - キーボード: Esc で閉じる / Ctrl+Enter で送信
- 確認待ちカードから「AI 実行ログ」セクションを削除し、全体パディング・余白・フォントを縮小して 1 画面で多くの情報が見られるようコンパクト化
- 企業一覧テーブルの送信日付セルを刷新 (緑モノ強調 → check_circle アイコン + 通常書体、複数回連絡時のみ「N回目」chip)
- ヘッダ (.app-header) の sticky 上書き (`position:relative`) を削除し、`#mainTabNav` がスクロール時に画面上部へ正しく固定されるように修正

## v1.2.7 - 2026-04-25

- 確認待ち (awaiting) カードを「送信内容の確認」パネルに刷新 (ヘッダ + 2カラム + フッタ)
- 送信済み (sent) カードを同じデザイン言語に統一し、連絡履歴をタイムライン表示
- スクリーンショットの拡大/縮小コントロールを追加 (50%–400% / 25%刻み / リセット)
- 「編集して修正」「返信を記録」「編集して再送」など将来機能のUIプレースホルダを配置
- 企業一覧テーブル (#mt) の列幅をドラッグで調整可能に (localStorage で永続化、ダブルクリックでリセット)

## v1.2.6 - 2026-04-25

- 自動アップデート経路の E2E 検証用リリース
- `verify:dist` ゲートを再確認

## v1.2.5 - 2026-04-25

- ダッシュボード正本を `src/dashboard-server.cjs` + `src/ui/**` + `src/routes/**` に分割
- プレビュー (3480) / 開発 Electron / パッケージ済み Electron が同一ソースから起動するように統一
- `scripts/verify-release-readiness.cjs` / `scripts/verify-surface-parity.cjs` を `predist` / `postdist` ゲートとして配線
- `scripts/preview-dashboard.cjs` を追加 (3480 でルートのダッシュボードを起動)
- `scripts/install-latest-win.ps1` を追加 (Sales Claw 起動中なら停止検知して安全にインストール)
- オフライン用 vendor 資産を `assets/vendor/` に同梱 (Inter / JetBrains Mono / Noto Sans JP / Material Symbols / Phosphor / Tailwind / Chart.js / xterm)
- `electron-builder` 設定を `joseikininsight-hue/sales-claw` / channel:latest / publishAutoUpdate:true に固定
- `local-test` / `${env.GH_OWNER}` / `${env.GH_REPO}` のプレースホルダフィードを禁止
- `docs/release-parity-and-autoupdate.md` / `.claude/commands/release-parity.md` を追加
- `AGENTS.md` / `CLAUDE.md` に Desktop Release / Auto Update Gate ルールを追加
- バッチ復旧用の `src/batch-watchdog` / `src/recovery-store` / `src/startup-cleanup` / `src/ai-runtime` を追加

## v1.0.9 - 2026-04-05

- Windows デスクトップ版を最新 UI / UX に更新
- Claude / Codex / Gemini の AI Provider 切り替えに対応
- 確認待ち・送信済み・企業一覧まわりの操作性と監査表示を改善
- 設定の Excel import / export とセットアップ補助を追加
- ダッシュボード API / ランタイム保護を強化
- `/api/data` のキャッシュ化、不要な多重起動抑止、ポーリングと描画負荷の見直しでパフォーマンス改善
- `Blocked cross-origin dashboard request.` の誤判定を修正
- テスト用の一時ファイル、検証用スクリプト、不要な残骸を整理
