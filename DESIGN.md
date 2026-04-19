# DESIGN.md — fence-editor 設計方針書

## 1. 設計思想

### 自動変換よりも人間の判断を優先する

コードフェンスのネスト構造はマークダウンの仕様上、infostringのない開始フェンスの意図を機械的に判定できない。自動変換を諦め、「仕様上の解釈を可視化してユーザーが組み替える」対話ツールとして設計する。

### 構造的健全性の維持

提案するアクションは常に文書全体の整合性を保つ必要がある。ゼロオーファン、異種シンボル間の境界交差禁止、構造変化の必須 — これらの検証を通過したもののみがUIに表示される。

### 責務を絞る

このツールが担うのは「コードフェンス構造の編集」のみ。マークダウン→Djot変換、シンタックスハイライト、前後行の文脈表示などは対象外とする。編集時の文脈確認は別のエディタに委ねる。

### 最小依存

外部依存はパーサー2つ（`micromark@^3.0.0`、`@djot/djot@^0.3.0`）のみ。TUIフレームワーク、引数パースライブラリ、readlineパッケージは一切使用しない。

### 厳格な型安全性

Strict TypeScript。`any` 型の使用は禁止。すべての変数・引数・戻り値に明示的な型を付与するか、完全な型推論に依存する。

---

## 2. アーキテクチャ

```
src/
├── cli.ts          # エントリポイント・フロー制御・ストリーム分離
├── args.ts         # CLIオプション定義、自前パーサー、フォーマット自動検出
├── runtime.ts      # Deno固有APIの薄いラッパー（stdin/TTY分離）
├── model/
│   ├── fence.ts    # FenceToken, FencePair などの型・純粋なデータ定義
│   └── state.ts    # EditorState, pairFences, generateValidActions, applyAction
├── parser/
│   ├── commonmark.ts   # micromarkを使ったパーサー
│   └── djot.ts         # djot.jsを使ったパーサー
└── ui/
    ├── render.ts   # Statusテーブルと ActionsのANSI描画（stderr専用）
    └── loop.ts     # 入力ループ・シグナルハンドリング
```

### 依存関係

```
cli.ts ──→ args.ts, runtime.ts, parser/*, model/state.ts, ui/*
parser/* ─→ model/fence.ts, model/state.ts (pairFences)
ui/render.ts ─→ model/fence.ts, model/state.ts
ui/loop.ts ─→ model/state.ts, ui/render.ts, runtime.ts
runtime.ts ─  (他モジュールに依存しない)
model/fence.ts ─  (他モジュールに依存しない)
model/state.ts ─→ model/fence.ts
```

**原則:** 純粋ロジックは `model/` と `parser/` に隔離。副作用（I/O、画面描画、プロセス制御）は `cli.ts`, `ui/loop.ts`, `runtime.ts` のみ。

### ユーティリティモジュール

`args.ts` に以下の純粋ユーティリティ関数を定義:

- **`resolveFormat(inputPath, explicitFormat)`**: 拡張子ベースのパーサー自動検出。明示的フラグ > 拡張子 > commonmarkフォールバックの優先順位。
- **`generateDefaultOutputPath(inputPath, format)`**: フォーマットに対応したデフォルト出力ファイル名生成。

---

## 3. データモデル

### model/fence.ts — 型・純粋なデータ定義

パーサー層からもimportされる共通の型定義を置く。`parser/`層はこのファイルのみに依存する。

```ts
interface FenceToken {
  line: number           // 行番号（1始まり）
  raw: string            // 元の行テキスト（80文字でtruncate済み）
  backtickCount: number  // バッククォートまたはチルダの個数（汎用のフェンス長フィールド）
  symbol: "backtick" | "tilde"
  infostring: string | null
  kind: "open" | "close"
  pairId: number         // ペアID（1始まり。0は未ペア）
}

interface FencePair {
  id: number
  open: FenceToken
  close: FenceToken
}

type FenceParser = (source: string) => FenceToken[]
```

### model/state.ts — 状態管理・組み替えロジック

```ts
interface EditorState {
  inputTokens: ReadonlyArray<FenceToken>  // 入力の不変スナップショット
  outputTokens: FenceToken[]              // 操作によって変化する可変コピー
  hasTilde: boolean                       // チルダフェンスが存在するか
  actionLog: string[]                     // 適用済み操作のラベルログ
  statusHistory: Array<{                  // 各アクション後のステータス履歴
    actionLabel: string
    table: string  // Markdown形式のステータステーブル
  }>
  format: "commonmark" | "djot"           // 解決済みパーサー形式
  skipRestructure: boolean                // チルダ変換後1フレームだけrestructure抑制
}
```

`inputTokens` は `Object.freeze()` で凍結され、実行中一切変更されない。`outputTokens` はアクション適用ごとに新しい配列で置換される。

**`skipRestructure` のライフサイクル:**
- 初期状態: `false`
- `convert-tilde` 適用後: `true` に設定 → 次の `generateValidActions` で restructure アクションが抑制される
- `restructure` 適用後: `false` にリセット → 再構築オプションが再び有効になる

---

## 4. パーサー層の設計

### 共通インターフェース

CommonMarkとDjotでパーサーを切り替えられるよう、どちらも同じ `FenceParser` 型を実装する:

```ts
type FenceParser = (source: string) => FenceToken[]
```

### フォーマット解決パイプライン

1. `--format` フラグが指定されていれば、その値をそのまま使用する。
2. 入力ファイルの拡張子から自動検出（`.md`/`.markdown`/`.mdx` → `commonmark`、`.dj`/`.djt` → `djot`）。
3. 不明な拡張子、拡張子なし、または stdin → `commonmark` にフォールバック。

この解決結果は `createEditorState(tokens, resolvedFormat)` に渡され、UIの `Parsed as <FORMAT>` 表示と出力ファイル名生成の両方で使用される。

### CommonMark（micromark）

1. `micromark(source)` で有効なCommonMarkか検証（失敗すれば例外）。
2. 各行をスキャン: 0〜3スペースのインデントを剥がし、3文字以上の連続バッククォートまたはチルダを検出。
3. フェンス文字の後の非空白内容は infostring として抽出（開始フェンスのみ）。
4. infostringあり → `kind: "open"`。infostringなし → `kind: "close"`（ペアリングロジックに委譲）。
5. `pairFences()` で最終的なペアリングを適用。

### Djot（djot.js）

1. `djot.parse(source, { sourcePositions: true })` でASTを取得。
2. ASTを走査し `code_block` ノードを収集。各ノードの `pos.start.line` と `pos.end.line` から開始/終了行を特定。
3. `lang` フィールドを infostring として使用。
4. 開始行: `kind: "open"`, infostringあり。終了行: `kind: "close"`, infostring=null。
5. `pairFences()` で最終的なペアリングを適用。

### `pairFences(tokens: FenceToken[]): FenceToken[]` — 純粋ペアリング関数

どちらのパーサーの出力に対しても、ペアリングは以下の共通ロジックで行う:

- **入力をミューテートしない** — 常に新しい配列を返す。
- バッククォートとチルダを独立に処理（同一 `nextPairId` カウンタを共有）。
- infostringあり → 強制的に `kind: "open"`、スタックにプッシュ。
- `kind: "open"` が明示的に設定されている → 同様に強制的にopen（アクション検証のシミュレーション用）。
- `kind: "close"` → スタックトップと最短マッチ。スタック空ならopenに昇格。
- デフォルト → 同上の最短マッチロジック。
- 残余のスタック要素は `pairId: 0`（未ペア）。

---

## 5. UI層の設計

### 描画方針

TUIフレームワークは使用しない。ANSIエスケープシーケンスを直接 `Deno.stderr.writeSync()` で出力して画面を再描画する。`console.clear()` は使用しない（`\x1b[H\x1b[2J` で画面クリア）。

**重要: 全UI出力は stderr に送信する。** `Deno.stdout` はドキュメントデータ出力のみに予約される。

操作のたびに画面全体を再描画する。テーブルは `state.outputTokens` から直接読み取る — 独立したUI状態配列は存在しない。

### stderr / stdout 分離

| ストリーム | 用途 | 具体例 |
|---|---|---|
| **stderr** | すべての対話UI | Terms、Statusテーブル、Actions、プロンプト、エラー、Goodbye |
| **stdout** | 再構築ドキュメントのみ | `[3] Print to stdout` 選択時のファイル内容 |

この分離により、`fence-editor input.md | grep "code"` のようなパイプラインで、UIはターミナルに表示され、ドキュメントデータのみがパイプを流れる。

### 出力先選択プロンプト

`0` で終了フローに入ると、以下の出力先選択プロンプトが stderr に表示される:

```
Choose output destination:

  [1] Save as new file
  [2] Overwrite input file
  [3] Print to stdout

  > Enter action # | 0 to return to editor | Ctrl+C to cancel
```

- `[1] Save as new file`: 新規ファイルパスの入力を求める。デフォルトは `${base}_edited.<ext>`。
- `[2] Overwrite input file`: 入力ファイルを上書き。stdin入力時はエラー。
- `[3] Print to stdout`: 再構築ドキュメントを stdout のみ出力。UIテキストは一切含まない。
- `[0] Cancel`: 保存せずにエディターに戻る。対話ループが再開され、追加のアクション適用が可能。

空の入力は静かに再プロンプト。`1`/`2`/`3`/`0` 以外の数値もエラー表示して再プロンプト。

### Statusテーブルのレンダリング

列幅の設計（全行64文字、80文字以内）:

```
| line | input                | I. | O. | output               |
|-----:|:---------------------|---:|---:|:---------------------|
  4      20                    2    2    20
```

| 列 | コンテンツ幅 | 整列 | データソース |
|---|---|---|---|
| `line` | 4 | 右 | トークンの `line` |
| `input` | 20 | 左（truncate） | `inputTokens[i].raw` |
| `I.` | 2 | 右 | `inputTokens[i].pairId`（0なら空白） |
| `O.` | 2 | 右 | `outputTokens[i].pairId`（0なら空白） |
| `output` | 20 | 左（truncate） | `outputTokens[i].raw` |

各行のフォーマット: `| ${col1} | ${col2} | ${col3} | ${col4} | ${col5} |` — パイプと内容の間にスペースが1つずつ入る。

セパレーター行はMarkdownのアライメント構文に従う: `|-----:|:---------------------|---:|---:|:---------------------|`。各セルのダッシュ数は対応するデータ行のセル幅（コンテンツ幅+スペース1つ）に一致する。

### 入力ループ

rawモードは使用しない。`runtime.ts` の `readLine()` で1行読み取り:

```ts
const line = await readLine()
const trimmed = line.trim().toLowerCase()
```

**空行・空白・非数値の入力** → エラーメッセージを出さず `continue`（静かに再プロンプト）。

### Ctrl+C ハンドリング

ループ開始時に `Deno.addSignalListener("SIGINT", ...)` を登録:

```ts
Deno.addSignalListener("SIGINT", () => {
  clearScreen();
  renderGoodbye();
  Deno.exit(0);
});
```

即座に終了コード0でabort。ファイル変更は一切保存されない。未処理の例外は発生しない。

### フッター行

Actionsリストの直下に以下のヒント行を毎回の再描画で必ず表示する:

```
  > Enter action # | 0 to exit & save | Ctrl+C to cancel
```

### Actions ヘッダー

簡潔な `Actions:` のみを表示。`"enter number to apply"` 等の冗長な説明は含めない（フッター行がその役割を果たす）。

### Actions の生成

`generateValidActions(state: EditorState): Action[]` が毎回動的に生成する。アクション型は `"restructure"` と `"convert-tilde"` の2種類のみ。アクションは `pairFences()` シミュレーションによって検証され、有効な遷移のみが含まれる。

1. ペアワイズクローズスワップ（主要）
2. シングルクローズチェンジ（未ペアトークン向けフォールバック）

クローズフェンス変更候補は、結果のトークンリストをシミュレートし、すべてのフェンスが完全にペアリングされることを確認することで検証される。このチェックをパスしたアクションのみが表示される。

3. `hasTilde === true` の場合のみ: チルダ→バッククォート変換（アトミック・オートアジャスト付き）

---

## 6. モデル層の設計

### `generateValidActions(state: EditorState): Action[]`

アクション生成はシミュレーション駆動。各候補に対して以下を実行:

1. `outputTokens` を `cloneTokens()` でディープクローン。
2. 候補の変更を適用（クローズスワップまたはシングルクローズチェンジ）。
3. `pairFences(cloned)` を実行。
4. 有効判定:
   a. `paired.every(t => t.pairId > 0)` — ゼロオーファン禁止。
   b. `!hasCrossSymbolCrossing(paired)` — 異種シンボル間の境界交差禁止。
   c. `getPairingStructure(paired) !== getPairingStructure(current)` — 構造変化必須（no-op除外）。
5. 有効な場合のみ `Action` を生成。

**`state.skipRestructure` が `true` の場合、手順1〜4の restructure 候補生成全体がスキップされる。** `convert-tilde` アクションは通常通り生成される。

**ペアワイズクローズスワップの詳細:**

2つのペア `(A, B)` で `A.close.line < B.open.line` の場合:
- `A.close` を `kind: "open"` に昇格。
- `B.open` を `kind: "close"` に設定。
- `pairFences()` 実行後、`A' = (A.open, B.close)`, `B' = (A.close, B.open)` の構造を検証。
- 同一シンボル種間でのみスワップを提案。

### `hasCrossSymbolCrossing(tokens: FenceToken[]): boolean`

純粋関数。異なるシンボル種のペア間で範囲交差が存在するかを検出する。

```
// 交差の定義: 一方のopenが他方のopenとcloseの間にあり、
// かつ一方のcloseが他方のcloseより外側にある
(A.open < B.open < A.close < B.close) ||
(B.open < A.open < B.close < A.close)
```

このチェックは `pairFences()` がゼロオーファンを返した**後に**実行される。技術的にはCommonMark/Djotにおいて異種シンボルは独立した名前空間だが、そのような構造は曖昧で読みにくいため、ツールはこれを「構造的に健全でない」としてブロックする。

**計算量:** O(P²) where P = number of pairs。P ≤ 50 のため実用上問題ない（<1ms）。

### `applyAction(state: EditorState, actionIndex: number): EditorState`

アクション番号に対応する操作を実行:

- **restructure**: クローン上でkind/pairIdを更新 → `pairFences()` → `autoAdjustBackticks()` → `raw` を `rebuildRaw()` で再生成 → `actionLog` にラベル文字列を追加 → `skipRestructure: false`。
- **convert-tilde**: 全 `tilde` を `backtick` に変換 → `raw` 再生成 → `autoAdjustBackticks()` でネスト調整 → `raw` 再生成 → `hasTilde: false` → `skipRestructure: true` → `actionLog` に追加。

`increase-backtick` 型のアクションは存在しない。ネストカウントの調整は restructure または convert-tilde の中でアトミックに実行される。

スワップアクションの場合、両ペアの4トークン（A.open, A.close, B.open, B.close）を一度に変更し、`pairFences()` に委譲して最終的なペアIDを決定する。

### `rebuildRaw(token: FenceToken): string`

トークンのプロパティから `raw` 文字列を再生成:

- `symbol === "backtick"` → `` ` `` を `backtickCount` 回繰り返す。
- `symbol === "tilde"` → `~` を `backtickCount` 回繰り返す。
- `kind === "open"` かつ `infostring !== null` の場合、フェンス文字の直後に infostring を連結。
- 閉じフェンスの場合はフェンス文字列のみ。

### `autoAdjustBackticks(tokens: FenceToken[]): FenceToken[]`

ネスト関係にあるペアを走査し、外側フェンスの `backtickCount` を必要最小値まで増加:

```
if (inner.open.line > outer.open.line && inner.close.line < outer.close.line) {
  if (inner.open.symbol === outer.open.symbol) {  // 同一シンボル種のみ
    if (outer.backtickCount < inner.backtickCount + 1) {
      outer.backtickCount = inner.backtickCount + 1  // 最小増分のみ
    }
  }
}
```

backtick↔backtick、tilde↔tilde のみで調整。シンボル種を跨ぐ調整は行わない。調整後、全トークンの `raw` を `rebuildRaw()` で再生成。

### `reconstructOutput(outputTokens: FenceToken[], originalLines: string[]): string`

1. `outputTokens` を行番号→トークンのMap化。
2. `originalLines` を走査。行番号がMapに存在すれば `token.raw` で置換、存在しなければ原文をそのまま保持。
3. 結果を `\n` で結合。

フェンス行以外のすべての行は一字一句変更されない。

---

## 7. runtime.ts の設計方針

Deno固有のAPIをここに集約し、将来的なランタイム変更に備える。

```ts
export function getArgs(): string[]
export function readStdin(): Promise<string>
export function readLine(): Promise<string>
export function writeFile(path: string, content: string): Promise<void>
export function exit(code: number): never
```

### stdin / TTY 分離

`readStdin()` と `readLine()` は異なるストリームから読み取る:

- **`readStdin()`**: `Deno.stdin` から全データを読み込む。パイプ入力に対応。
- **`readLine()`**: インタラクティブプロンプト用。**常に制御端末から読み取る。**

`readLine()` の実装:

1. `Deno.stdin.isTerminal()` をチェック。
2. `false` の場合（パイプ入力）、`/dev/tty`（Unix）または `CON`（Windows）を開いて対話入力を読み取る。
3. いずれも失敗した場合はフォールバックとして `Deno.stdin` を使用する。
4. 端末ハンドルをキャッシュし、呼び出しごとに再オープンしない（リソースリーク防止）。
5. 1バイトずつ読み取り `\n` で区切る。末尾の `\r` は除去する。

これにより、`cat file.md | fence-editor` のようなパイプラインでもUIは正しく端末で待機し、無限ループやフリッカーを回避する。

---

## 8. 開発・配布方針

### JSRへの公開

`deno.json` を基点とし、JSRに公開する。

```json
{
  "name": "@yourname/fence-editor",
  "version": "0.1.0",
  "exports": {
    ".": "./src/cli.ts"
  }
}
```

### 依存パッケージ

```json
{
  "imports": {
    "micromark": "npm:micromark@^3.0.0",
    "@djot/djot": "npm:@djot/djot@^0.3.0"
  }
}
```

### パーミッション

```sh
deno run --allow-read jsr:@yourname/fence-editor input.md                    # stdoutのみ（[3]）
deno run --allow-read --allow-write jsr:@yourname/fence-editor input.md      # 保存/上書きあり（[1]/[2]）
```

stdoutのみの場合（`[3] Print to stdout`）、`--allow-write` は不要。パイプライン統合時は `--allow-read` のみで動作する。

---

## 9. 実装優先順位

| 優先度 | 機能 | 状態 |
|---|---|---|
| 高 | CommonMarkパーサー（micromark）、Statusテーブル描画、連番入力ループ | 完了 |
| 高 | ペアの可視化（I./O.の表示） | 完了 |
| 高 | ペアワイズクローズスワップ + シミュレーション検証 | 完了 |
| 高 | `applyAction` による状態ミューテーション + raw再生成 | 完了 |
| 高 | `reconstructOutput` による出力ファイル再構築 | 完了 |
| 高 | stderr/stdout ストリーム分離（UI vs データ） | 完了 |
| 高 | stdin/TTY 分離（パイプ入力対応） | 完了 |
| 高 | 異種シンボル境界交差の禁止（`hasCrossSymbolCrossing`） | 完了 |
| 高 | チルダ変換後の再構築サプレス（`skipRestructure`） | 完了 |
| 中 | Djotパーサー（djot.js）、フォーマット切り替え | 完了 |
| 中 | チルダ→バッククォート変換Action（アトミック・オートアジャスト付き） | 完了 |
| 中 | フェンス数自動調整（ネストルール準拠、シンボル種別対応） | 完了 |
| 中 | ヘルプドキュメント強化、空入力・Ctrl+C対応 | 完了 |
| 中 | フォーマット自動検出 + フォーマット対応デフォルト出力ファイル名 | 完了 |
| 中 | UI改善: `Actions:` ヘッダー簡素化、`Parsed as` 表示、フッター行 | 完了 |
| 完了 | Statusログのファイル保存 | 完了 |
