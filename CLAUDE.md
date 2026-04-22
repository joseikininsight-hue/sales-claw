# Sales Claw

## About This Project

企業の問い合わせフォーム経由で営業アプローチを自動化するツール。
ユーザーが設定した自社情報・ターゲットリスト・提供価値に基づいて、Claude Code CLIが企業分析→メッセージ生成→フォーム入力を実行する。

## 絶対ルール: フォーム入力+スクショなしで「確認待ち」にするな

**これはこのプロジェクトで最も重要なルール。違反は許されない。**

「確認待ち」(awaiting_approval) にログを記録する前に、以下の全ステップを**必ず完了**すること:

1. **フォームURLにアクセス** — Electronモード: `/api/form-session/create`、MCPモード: `browser_navigate`
2. **フォーム構造を解析** — Electronモード: `/api/form-session/{id}/structure`、MCPモード: `browser_snapshot`
3. **全フィールドに実際に入力** — Electronモード: `/api/form-session/{id}/fill`、MCPモード: `browser_fill_form`
4. **入力済みフォームのスクリーンショット撮影** — Electronモード: `/api/form-session/{id}/screenshot`、MCPモード: `browser_take_screenshot` で `screenshots/ss-{No}-input.png`
5. **ログ記録** — `form_fill` → `confirm_reached` → `awaiting_approval` の順でログ

### やってはいけないこと（厳禁）:
- メッセージを生成しただけで `awaiting_approval` にする
- フォームにアクセスせずに `form_fill` ログを書く
- スクリーンショットを撮らずに確認待ちにする
- 「フォームが見つからなかった」で黙って確認待ちにする → `error` ログにして理由を明記

### フォーム入力に失敗した場合:
- CAPTCHA・reCAPTCHA → `error` ログ + 理由「CAPTCHA検出」+ スクショ
- フォームが見つからない → `error` ログ + 理由 + フォーム探索結果
- 入力はできたがフィールド不足 → 入力できた分のスクショを撮って `awaiting_approval` + 不足内容をログに明記

### 営業NG・対象外フォームの扱い:
- 「営業目的のお問い合わせはご遠慮ください」「既存顧客専用」「採用専用」「IR専用」「報道専用」などの記載がある場合は**送信対象外**
- 送信対象外の場合は**フォーム入力しない**
- `awaiting_approval` にしてはいけない
- `logAction(no, name, 'skipped', '営業NG/対象外: 理由')` を記録して終了する
- 可能なら理由を `live-monitor` にも反映する

### 入力項目ルール:
- 最低限の基本項目は `会社名 / 担当者名 / メール / 電話 / 問い合わせ本文`
- `部署 / 役職 / 担当者名カナ / 郵便番号 / 住所 / 携帯 / FAX / Webサイト` は、フォームに明示的な対応項目がある場合だけ入力する
- 設定に存在しない値を推測して埋めてはいけない
- `companyProfile.notes` のような内部メモはフォーム入力や送信本文に使ってはいけない

**ユーザーはダッシュボードのスクショを見て送信判断する。スクショがなければ判断できない。**

## Architecture — CLI主体

**重要: このプロジェクトはClaude Code CLIが主体で動く。**

- Claude Codeがその場で企業を分析し、メッセージを作成し、フォームに入力する
- ダッシュボード（localhost:設定ポート）はUI表示・操作・設定管理

### フォーム入力モード（2種類、優先順位あり）

**【第1優先】Electronモード — Form Session API**
- Electronアプリが起動しているとき（ダッシュボードにアクセス可能なとき）はこちらを使う
- POST /api/form-session/create → 構造取得 → マッピングJSON生成 → fill → screenshot
- MCP Playwright は**使わない**（接続されていなくてOK）
- ユーザーはダッシュボードの「フォーム確認」ボタンでElectron内フォームを確認して手動送信

**【第2優先・フォールバック】MCP Playwrightモード**
- Electronが起動していないとき（CLIのみで動かすとき）に使う
- MCP Playwrightが接続されていないなら**このモードは使えない → エラーにする**
- 調査フェーズ: サブエージェントが並列で Bash + node -e 実行（MCP不使用）
- 入力フェーズ: browser_snapshot → browser_fill_form → browser_take_screenshot で1社ずつ入力
- タブは閉じない（ユーザーが各タブで内容を確認して手動送信）

**モード選択の原則: MCP Playwright が使えないなら即座にElectronモードへ切替える。絶対にMCPを必須条件にしない。**

## Configuration

全設定は `data/settings.json` で管理。ダッシュボードのSettingsタブから編集可能。

### 設定の読み取り方法

```javascript
const settings = require('./settings-manager.cjs');

// 会社情報
const sender = settings.getSender();

// 自社の強み
const strengths = settings.getStrengths();

// 協業パターン
const patterns = settings.getSuccessPatterns();

// 業種別プロフィール
const profiles = settings.getIndustryProfiles();

// ターゲットリストパス
const listPath = settings.getTargetListPath();

// 除外ステータス
const excludes = settings.getExcludeStatuses();
```

初回セットアップ:
```bash
cp data/sample-settings.json data/settings.json
```

## Workflow

**1社あたりの必須フロー（省略不可）:**
```
Step 0: モード検出（必ず最初に実行）
  → Bash で以下を実行してElectronダッシュボードの疎通確認:
      node -e "
        const s = require('./settings-manager.cjs');
        const port = s.getPort();
        require('http').get('http://127.0.0.1:'+port+'/api/form-session', r => {
          process.stdout.write(r.statusCode < 400 ? 'electron' : 'mcp');
          process.exit(0);
        }).on('error', () => { process.stdout.write('mcp'); process.exit(0); });
      "
  → 出力が 'electron' → Electronモードで進める（Step 3〜6はすべてForm Session API使用）
  → 出力が 'mcp' → MCP Playwrightが接続されているか確認
      - MCP Playwright接続済み → MCPフォールバックモードで進める
      - MCP Playwright未接続  → ユーザーに「Electronアプリを起動してください」と伝えてエラーログを記録して終了
  ★ 「MCP Playwrightが接続されていない」は単独でエラーにしない。Electronモードで代替できる。

Step 1: 企業サイト分析
  → company-analyzer.cjs (Bash) でサイト巡回（Playwright不要 — HTTP fetchベース）
  → logAction(no, name, 'site_analysis', 分析結果)

Step 2: メッセージ生成（CLI言語能力を活用）
  → message-builder.cjs の buildMessagePrompt(analysis) でプロンプト+コンテキスト生成
  → CLIエージェントが messagePrompt に基づき、企業ごとにパーソナライズした文面を実際に作成
  → approachObjective / approachGuardrails が自動反映される
  → フォールバック: buildCustomMessage(analysis) のテンプレート文面
  → logAction(no, name, 'message_draft', メッセージ全文)

Step 3: フォームセッション作成（Electronモード） / またはMCPフォールバック
  ─── Electronモード（推奨） ───────────────────────────────
  → POST /api/form-session/create  { formUrl, companyNo }
  → sessionId を受け取る（Electron内 WebContentsView がバックグラウンドで開く）
  → フォームURLが未登録なら「会社名 問い合わせ」でGoogle検索し公式ドメインを使う
  ─── MCP Playwright フォールバック（Electron非起動時） ────
  → 1社目: browser_navigate でフォームURLを開く
  → 2社目以降: browser_evaluate で window.open(url,'_blank') → browser_tabs
  → browser_snapshot でフォーム構造を解析

Step 4: フォーム構造解析とマッピング判断
  ─── Electronモード ──────────────────────────────────────
  → GET /api/form-session/{sessionId}/structure
  → 返ってきた [{selector, label, type, required}] を見て、どの項目に何を入れるか判断
  → 以下のフォーマットでマッピングJSONを生成:
    [
      { "selector": "#company", "valueKey": "companyName", "type": "text" },
      { "selector": "#email",   "valueKey": "email",       "type": "text" },
      { "selector": "#message", "value": "生成した本文",   "type": "textarea" }
    ]
  → valueKey は sender の既知フィールド名（companyName/contactName/email/phone/address等）
  → 自由テキスト（本文）は value に直接入れる
  ─── MCP Playwright フォールバック ────────────────────────
  → browser_fill_form で全フィールドに入力（従来通り）

Step 5: フォームに入力 ★ 絶対省略するな
  ─── Electronモード ──────────────────────────────────────
  → POST /api/form-session/{sessionId}/fill  { mappings: [...] }
  → backend が settings の値を検証してから WebContentsView に入力
  → logAction(no, name, 'form_fill', '入力完了')
  ─── MCP Playwright フォールバック ────────────────────────
  → 従来通り。logAction(no, name, 'form_fill', '入力完了')

Step 6: スクリーンショット ★ 絶対省略するな（ファイル名を厳守すること）
  ─── Electronモード ──────────────────────────────────────
  → POST /api/form-session/{sessionId}/screenshot  { suffix: "input" }
  → Electron が capturePage() で screenshots/ss-{No}-input.png に保存
  ─── MCP Playwright フォールバック ────────────────────────
  → browser_take_screenshot で screenshots/ss-{No}-input.png に保存（必須）
  → logAction(no, name, 'confirm_reached', 'スクショ撮影完了')

Step 7: 確認待ちに登録
  → logAction(no, name, 'awaiting_approval', 'ダッシュボードで確認待ち')
  → ★ Step 5, 6 が完了していない場合、このステップに進んではいけない
  → Electronモードでは WebContentsView がバックグラウンドで保持される
  → ユーザーは確認待ちタブの「フォーム確認」ボタンで Electron 内のフォームを見て送信する
```

**複数社の場合（2フェーズ並列処理）:**
```
「3社確認待ちまで」と指示された場合:
→ 一気に最後まで進める。途中でメッセージ承認を求めて止まらない。

フェーズA（並列実行 — MCP不使用）:
→ 各社の「サイト分析 + メッセージ生成プロンプト構築」を並列サブエージェントで同時処理
→ 方法: Agent ツールで haiku サブエージェントを並列起動:
    node src/parallel-analysis.cjs '{"no":1,"companyName":"会社名","url":"URL","type":"種別","formUrl":"フォームURL"}'
→ サブエージェント内で company-analyzer + message-builder を使用
→ 出力: analysis + messagePrompt（CLI用プロンプト）+ templateDraft（フォールバック）
→ MCP Playwright は使わない（直接 HTTP フェッチのみ）
→ thinking() + updateLiveMonitor() で進行状況をダッシュボードに通知
→ 全社のフェーズAが完了するまでフェーズA.5に進まない

フェーズA.5（メッセージ生成 — CLI言語能力を活用）:
→ フェーズAの分析結果 + messagePrompt をフォーム入力用 batch payload に載せる
→ CLIは messagePrompt を使って企業ごとに本文を最終化し、templateDraft はフォールバックとして扱う
→ messagePrompt には approachObjective / approachGuardrails / サイト抜粋 / ギャップ分析が含まれる
→ CLIが自然な日本語で、テンプレート感のない「この会社だけに書いた」文面を生成する
→ templateDraft はCLI生成に失敗した場合のフォールバック

フェーズB（順次実行 — フォーム入力）:
→ フェーズA.5完了後、1社ずつフォーム入力（Step 0で決定したモードに従う）

  ─── Electronモード（ダッシュボード起動済み） ─────────────────
  → 各社: POST /api/form-session/create → GET structure → マッピングJSON → POST fill
           → POST screenshot → logAction(awaiting_approval)
  → MCP Playwright は使わない

  ─── MCPフォールバック（Electron未起動 かつ MCP接続済み） ────
  → 各社: browser_navigate(新タブ) → browser_snapshot → browser_fill_form
           → browser_take_screenshot → logAction(awaiting_approval)
  → タブは閉じずに残す

→ thinking() + updateLiveMonitor() で進行状況をダッシュボードに通知

全社完了後、結果を集約してユーザーに報告
→ 送信判断はダッシュボードの確認待ちタブで人間が行う

「〇〇に送って」の場合:
→ メッセージ案をユーザーに提示 → 承認されたら入力→スクショまで進める
```

**進行状況通知（必須）:**
```
各ステップで cli-logger.cjs を呼んで進行状況をダッシュボードに反映する:

const { thinking, log } = require('./src/cli-logger.cjs');

フェーズA開始: thinking('フェーズA開始: N社の並列分析')
各社分析開始: thinking('[No.X] 会社名: サイト分析開始')
各社プロンプト: thinking('[No.X] 会社名: メッセージプロンプト生成中')
フェーズA.5開始: thinking('フェーズA.5開始: CLIメッセージ生成')
各社CLI生成: thinking('[No.X] 会社名: CLIでパーソナライズ文面生成中')
フェーズB開始: thinking('フェーズB開始: フォーム入力（順次処理）')
各社フォーム入力: thinking('[No.X] 会社名: フォーム入力中')
各社完了: log('[No.X] 会社名: 確認待ち登録完了', 'action')
```

## Message Generation

メッセージはCLIの言語能力を活用して企業ごとにパーソナライズ生成する。

### 生成フロー
1. `parallel-analysis.cjs` が企業サイトを分析 → analysis（事業領域・ギャップ・注力分野・サイト抜粋）
2. `message-builder.cjs` の `buildMessagePrompt(analysis)` がCLI用プロンプトを構築
3. CLIエージェントがプロンプトに基づき、相手企業に刺さる文面を生成
4. フォールバック: `buildCustomMessage(analysis)` のテンプレート文面

### 設定参照先
- `companyProfile` — 送信者情報
- `valuePropositions.strengths` — 自社の強み（ギャップ分析に使用）
- `valuePropositions.successPatterns` — 協業実績
- `valuePropositions.industryProfiles` — 業種別テンプレート（フォールバック用）
- `messageTemplates` — 文面のトーン・署名・CTA
- `messageTemplates.approachObjective` — 営業方針（CLIプロンプトに自動反映）
- `messageTemplates.approachGuardrails` — 禁止事項（CLIプロンプトに自動反映）

### メッセージ作成方針（CLIプロンプトに組み込み済み）
- 相手がやりたいことから入る（自社紹介から始めない）
- この会社だけに書いた感を出す（テンプレート感を排除）
- 全部伝えようとしない（尖った強み1-2個に集中）
- Win-Winは匂わせ程度（押し売り感を排除）
- 実績は控えめに（企業名を全面に出さない。数字は使ってOK）
- **相手に何を提供できるかを前面に**
- 相手の事業に触れる（「貴社の〇〇事業を拝見」）
- 相手の強み × 自社の強みの組み合わせ提案
- 相手の課題を決めつけない

## OMC（oh-my-claudecode）モデルルーティング — トークン節約

このプロジェクトはOMCのモデルルーティングに対応。
各ステップで最適なモデルを使い分けることで、**トークンコストを60-70%削減**できる。

### インストール（初回のみ）
```bash
claude /install oh-my-claudecode
```

### ステップ別モデル割り当て

| ステップ | 処理内容 | モデル | 理由 |
|---------|---------|--------|------|
| 企業サイト分析 | URL巡回→テキスト抽出→事業領域検出 | **haiku** | パターンマッチング。深い推論不要 |
| フォーム探索 | リンク辿り→フォームURL特定 | **haiku** | 単純なWeb巡回 |
| フォーム検証 | フォーム構造解析→入力可否判定 | **haiku** | 構造チェックのみ |
| メッセージ生成 | ギャップ分析→カスタム文面作成 | **sonnet** | 自然な日本語の文章生成が必要 |
| フォーム入力 | MCP Playwright操作→フィールド入力 | **sonnet** | フォーム構造の理解+正確な操作 |
| ダッシュボード設定変更 | settings.json読み書き | **haiku** | CRUD操作のみ |
| 除外判定・企業選定 | リスト走査→条件マッチ | **haiku** | ルールベース判定 |
| エラー対応・デバッグ | フォーム入力失敗の原因調査 | **opus** | 複雑な問題解決 |
| ワークフロー全体指揮 | 複数社の並列処理オーケストレーション | **sonnet** | メイン制御 |

### OMCエージェント活用マッピング

```
企業分析（並列）  → explore (haiku) × N社同時
メッセージ生成     → executor (sonnet) — 文章品質が重要
フォーム入力       → メインが直接MCP操作 (sonnet)
設定変更          → executor-low (haiku) — 単純なJSON操作
エラー調査        → architect (opus) — 複雑なデバッグのみ
```

### 典型的な「3社確認待ちまで」のトークン配分

```
従来（全てopusで実行した場合）:
  3社 × (分析 + メッセージ + フォーム入力) ≈ 150K tokens @ opus

OMCルーティング適用後:
  分析:     3社 × 10K tokens @ haiku  = 30K (コスト: opus比 1/10)
  メッセージ: 3社 × 8K tokens @ sonnet = 24K (コスト: opus比 1/5)
  フォーム:   3社 × 15K tokens @ sonnet = 45K (コスト: opus比 1/5)
  合計: 99K tokens, 実効コスト ≈ 従来の 25-30%
```

### 使い方

OMCインストール済みなら、自動的にモデルルーティングが適用される。
手動でモデルを指定する場合:

```
# 企業分析を haiku で実行
Agent(model: "haiku", prompt: "企業分析して")

# メッセージ生成を sonnet で実行
Agent(model: "sonnet", prompt: "メッセージ生成して")
```

OMCのultraworkモードで並列実行する場合:
```
/ultrawork
→ 3社の企業分析を haiku エージェント3つで同時実行
→ 完了後、sonnet でメッセージ生成
→ メインがMCP Playwrightでフォーム入力
```

## File Structure

```
sales-claw/
├── CLAUDE.md                   # このファイル（プロジェクト説明）
├── settings-manager.cjs        # 設定管理（全設定のSingle Source of Truth）
├── config.cjs                  # 設定読み取りインターフェース
├── electron-main.js            # Electron メインプロセス
├── src/
│   ├── dashboard-server.cjs    # ダッシュボード + 設定UI
│   ├── action-logger.cjs       # 操作ログ管理
│   ├── contact-history.cjs     # 連絡履歴管理
│   ├── company-analyzer.cjs    # 企業サイト分析
│   ├── form-validator.cjs      # フォーム事前検証
│   ├── form-finder.cjs         # フォームURL探索
│   ├── form-helpers.cjs        # フォーム操作ヘルパー
│   ├── live-monitor.cjs        # 進行状況モニター管理
│   ├── message-builder.cjs     # メッセージ生成
│   ├── parallel-analysis.cjs   # 並列サブエージェント用 分析+メッセージ生成
│   ├── email-fetcher.cjs       # Outlookメール取得
│   └── cli-logger.cjs          # ダッシュボードCLI Activity通知
├── data/
│   ├── settings.json           # 全設定（.gitignore対象）
│   ├── sample-settings.json    # 設定サンプル
│   ├── sample-targets.csv      # 公開用サンプルターゲット
│   ├── action-log.json         # 全操作ログ
│   └── contact-history.json    # 連絡履歴
└── screenshots/                # フォーム入力・確認画面のスクショ
```

## Agent Orchestration

このプロジェクトは **Claude（オーケストラ）+ CODEX（バックエンド実装）** の2エージェント体制で開発する。

| 担当 | エージェント | 対象 |
|------|------------|------|
| フロントエンド・UI設計・統合 | **Claude** | HTML/CSS/i18n/ダッシュボードUI |
| バックエンド実装 | **CODEX** | .cjs サーバーロジック・データ処理・ファイル操作 |

### CODEX 呼び出し

```bash
codex exec -m gpt-5.4 -s workspace-write "タスク内容"
```

- モデル: `gpt-5.4`（最高モデル。`o3`はChatGPTアカウントで未対応）
- 作業ディレクトリ: `C:\bp-outreach`

## Session Quick Start

1. `npm start` または Electron アプリでダッシュボード起動
2. ユーザーの指示に従って営業アプローチを実行
3. 設定が未完了の場合はダッシュボードのSettingsタブで設定を促す
