# DESIGN.md — fence-editor 設計方針書

## 1. 設計思想

### 自動変換よりも人間の判断を優先する

コードフェンスのネスト構造はマークダウンの仕様上、infostringのない開始フェンスの意図を機械的に判定できない。自動変換を諦め、「仕様上の解釈を可視化してユーザーが組み替える」対話ツールとして設計する。

### 責務を絞る

このツールが担うのは「コードフェンス構造の編集」のみ。マークダウン→Djot変換、シンタックスハイライト、前後行の文脈表示などは対象外とする。編集時の文脈確認は別のエディタに委ねる。

### 最小依存

外部依存はパーサー2つ（micromark、djot.js）のみ。TUIフレームワーク、引数パースライブラリは使用しない。

---

## 2. アーキテクチャ

```
src/
├── cli.ts          # エントリポイント・引数パース
├── args.ts         # CLIオプション定義と自前パース
├── runtime.ts      # Deno固有APIの薄いラッパー
├── model/
│   ├── fence.ts    # FenceToken, FencePair などの型・純粋なデータ定義
│   └── state.ts    # EditorState, ペアリング・組み替えロジック
├── parser/
│   ├── commonmark.ts   # micromarkを使ったパーサー
│   └── djot.ts         # djot.jsを使ったパーサー
└── ui/
    ├── render.ts   # Statusテーブルと Actionsの描画
    └── loop.ts     # 入力ループ・状態更新
```

---

## 3. データモデル

### model/fence.ts — 型・純粋なデータ定義

パーサー層からもimportされる共通の型定義を置く。`parser/`層はこのファイルのみに依存する。

```ts
interface FenceToken {
  line: number           // 行番号（1始まり）
  raw: string            // 元の行テキスト（80文字でtruncate済み）
  backtickCount: number  // バッククォートまたはチルダの個数
  symbol: "backtick" | "tilde"
  infostring: string | null
  kind: "open" | "close"
  pairId: number         // ペアID
}

interface FencePair {
  id: number
  open: FenceToken
  close: FenceToken
}
```

### model/state.ts — 状態管理・組み替えロジック

```ts
interface EditorState {
  inputTokens: FenceToken[]   // 入力の固定スナップショット
  outputTokens: FenceToken[]  // 操作によって変化するコピー
  hasTilde: boolean           // チルダフェンスが存在するか
  actionLog: string[]         // 適用済み操作のログ
}
```

---

## 4. パーサー層の設計

### 共通インターフェース

CommonMarkとDjotでパーサーを切り替えられるよう、どちらも同じ`FenceToken[]`を返す関数として実装する。`FenceToken`の型定義は`model/fence.ts`から共通でimportする。

```ts
type FenceParser = (source: string) => FenceToken[]
```

### CommonMark（micromark）

micromarkはトークンストリームとして処理するため、`codeFencedFence`、`codeFencedFenceSequence`、`codeFencedFenceInfo`トークンを拾うことでバッククォート数・infostring・行番号を取得できる。

### Djot（djot.js）

djot.jsのイベントベースAPIを使い、`code_block`イベントの開始・終了をFenceTokenに変換する。

### フェンスのペアリング

どちらのパーサーの出力に対しても、ペアリングは以下の共通ロジックで行う:

- infostringありのフェンスを開始確定とする
- infostringなしのフェンスはスタックを使って最短マッチでペアを組む
- pairIdは1始まりの連番で付与する

---

## 5. UI層の設計

### 描画方針

TUIフレームワークは使用しない。ANSIエスケープシーケンスを直接出力して画面を再描画する。操作のたびに`console.clear()`相当でリセットし、Statusテーブル全体を再描画する。

### Statusテーブルのレンダリング

列幅の設計（合計80文字以内）:

```
| line | input                | I. | O. | output               |
|-----:|:---------------------|---:|---:|:---------------------|
  6      22                    4    4    22                 = 58 + パイプ・スペース = 80
```

`input`・`output`列は22文字でtruncateし、超過分は無視して表示しない。

### 入力ループ

rawモードは使用しない。`prompt()`またはDenoの標準入力ライン読み取りで連番入力を受け付ける。

```ts
const line = await readLine()  // runtime.tsのラッパー経由
const choice = parseInt(line.trim())
```

### Actions の生成ルール

`EditorState`からActionsリストを毎回動的に生成する:

1. ペアの組み替え候補（閉じフェンスの変更）
2. バッククォート数の増加が必要なペア
3. `hasTilde === true` の場合のみ: チルダ→バッククォート変換

---

## 6. モデル層の設計

### ペア組み替えロジック

ユーザーが「O.1の閉じフェンスをline 13からline 298に変更」を選択した場合:

1. `outputTokens`のコピーを作成
2. 元の閉じフェンス（line 13）を開始フェンスに昇格させる
3. 新しい閉じフェンス（line 298）に対応する終了マークを設定
4. 影響を受けるpairIdを振り直す
5. 外側フェンスのバッククォート数が内側より多くなるよう自動調整する

### バッククォート数の自動調整

ペア組み替え後、ネスト関係にあるペアを検出し、外側のバッククォート数が内側+1以上になるよう最小限の増加を行う。

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

---

## 8. 開発・配布方針

### JSRへの公開

`deno.json`を基点とし、JSRに公開する。

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
    "djot": "npm:@djot/djot@^0.3.0"
  }
}
```

### パーミッション

```sh
deno run --allow-read --allow-write jsr:@yourname/fence-editor input.md
```

書き込みが不要な場合（stdoutのみ）は`--allow-read`のみで動作する。

---

## 9. 実装優先順位

| 優先度 | 機能 |
|---|---|
| 高 | CommonMarkパーサー（micromark）、Statusテーブル描画、連番入力ループ |
| 高 | ペアの可視化（I./O.の表示） |
| 中 | ペア組み替えAction、バッククォート数自動調整 |
| 中 | Djotパーサー（djot.js）、フォーマット切り替え |
| 中 | チルダ→バッククォート変換Action |
| 低 | Statusログのファイル保存 |
