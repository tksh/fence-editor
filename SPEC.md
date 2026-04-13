# SPEC.md — fence-editor 実装要件定義書

## 1. プロジェクト概要

**ツール名:** `fence-editor`
**目的:** マークダウンおよびDjot文書に含まれるコードフェンスのペア構造を可視化し、ユーザーが対話的に組み替えられるCLIツール。
**主なユースケース:** AIチャットのログなど、複数ソースからマージされたマークダウン文書において、コードフェンスのネスト構造が意図通りになっていない場合の修正。

---

## 2. 対応フォーマット

| フォーマット | パーサー |
|---|---|
| CommonMark | micromark |
| Djot | djot.js |

起動時の `--format` オプションで選択する。デフォルトはCommonMark。

---

## 3. CLIインターフェース

### 基本構文

```sh
fence-editor [input-file] [options]
```

stdin からの入力も受け付ける:

```sh
cat input.md | fence-editor
cat input.dj | fence-editor --format djot
```

### ヘルプ出力

```
Usage: fence-editor [input-file] [options]

Options:
  --format <commonmark|djot>  Set parser format (default: commonmark)
  --version                   Show version information
  -h, --help                  Show this help

Interactive Mode:
  Enter a number from Actions to apply changes to the fence structure.
  Press 0 or q to exit, choose an output destination, and save changes.
  Press Ctrl+C to abort immediately without saving any changes.
  Output destinations: [1] Save as new file, [2] Overwrite input, [3] Print to stdout

Examples:
  fence-editor input.md
  fence-editor input.md --format djot
  cat input.md | fence-editor --format commonmark
```

### オプション一覧

| オプション | 説明 |
|---|---|
| `--format <commonmark\|djot>` | パーサーの指定（デフォルト: commonmark） |
| `--version` | バージョン表示 |
| `-h, --help` | ヘルプ表示 |

### 入力ファイル未指定時の挙動

入力ファイルが指定されずstdinも空の場合、エラーメッセージを出力して終了コード1で終了する。

### 出力先の選択

対話UIで `0` または `q` を入力すると終了フローに入り、以下の出力先選択プロンプトが表示される:

```
Choose output destination:

  [1] Save as new file
  [2] Overwrite input file
  [3] Print to stdout

> _
```

- `[1] Save as new file`: 新規ファイルパスの入力を求め、デフォルトは入力ファイル名の `_edited` サフィックス付きパス。stdin入力のデフォルトは `output.md`。
- `[2] Overwrite input file`: 入力ファイルを上書き。stdinからの入力だった場合はエラーで終了。
- `[3] Print to stdout`: 画面上に改変後のソース全体を出力。

---

## 4. 対話UIの仕様

### 4.1 起動後の表示構成

```
Terms:

  I. = fence pair id (input)
  O. = fence pair id (output)

Status:
| line | input                | I. | O. | output               |
|-----:|:---------------------|---:|---:|:---------------------|
|    5 | ```                  |  1 |  2 | ````                 |
|    8 | ```                  |  1 |  1 | ```                  |
|   11 | ```                  |  2 |  1 | ```                  |
|   14 | ```                  |  2 |  2 | ````                 |

  O.1: line 8 → line 11 (backtick, 3x)
  O.2: line 5 → line 14 (backtick, 4x)

Actions (enter number to apply):

  [1] Change close fence for O.1 from line 8 to line 14 (auto-pairs O.2 to line 11)

  > Enter action # | 0 or q to exit & save | Ctrl+C to cancel

> _
```

### 4.2 表示仕様

- 横幅は **80文字固定**。すべてのUI出力はこの制約内に収まる。
- `input` / `output` 列は22文字でtruncateして表示。
- `input` 列と `I.` 列は初期パーサー結果の不変スナップショット（`inputTokens`）を表示し、操作によって変更されない。
- `O.` 列と `output` 列は `outputTokens` のライブ状態を反映し、操作適用のたびに更新される。
- `O.` 列は `outputTokens[i].pairId` を直接表示する（0の場合は空白）。
- `output` 列は `outputTokens[i].raw` を直接表示する（truncate済み）。
- ペアサマリー行: Statusテーブルの直下に `O.{id}: line {open} → line {close} ({symbol}, {count}x)` を緑色で表示。

### 4.3 操作方式

- 連番入力方式: `Actions` に表示された番号を入力しEnterで確定。
- 操作を適用するたびに `Status` テーブルと `Actions` が全再描画される。
- **空行・空白のみの入力・非数値の入力** はエラーメッセージを出さず、静かに再プロンプトする。
- `0` または `q` + Enter で終了フローへ移行（出力先選択）。
- `Ctrl+C` は即座に終了コード0でabort。ファイルへの変更は一切保存されない。

### 4.4 必須フッター行

Actionsリストの直下に以下のヒント行を毎回の再描画で必ず表示する:

```
  > Enter action # | 0 or q to exit & save | Ctrl+C to cancel
```

### 4.5 Actionsの内容

**シミュレーション検証によって生成されるもの:**

- フェンスのペアの組み替え（閉じフェンスの変更） — シングルクローズチェンジまたはペアワイズクローズスワップにより、ゼロオーファンかつ構造変化のある遷移のみが表示される。
- バッククォート数の増加（外側フェンスを内側より多くする） — ネスト違反が検出されたペアのみ。

**条件付きで表示されるもの:**

- **チルダフェンスが存在する場合のみ:** `Convert tilde fences to backticks`（全チルダフェンスをバッククォートに変換）。

---

## 5. コードフェンスのパース仕様

### 5.1 フェンスの判定ルール

CommonMark / Djot いずれも以下のルールに従う:

- infostringが付与されているフェンスは**開始フェンス確定**（終了フェンスはinfostring不可）。
- infostringのないフェンスは `kind: "close"` として初期化され、ペアリングロジックで再判定される。
- `pairFences()` はスタックベースの最短マッチでペアを組む。スタックにopenがある場合、現在のトークンをcloseとしてペアリングする。スタックが空の場合、現在のトークンをopenとしてスタックにプッシュする。
- バッククォートとチルダは別種のシンボルとして独立に処理される。同一ドキュメント内で混在していても互いに干渉しない。

### 5.2 `pairFences()` の詳細

`pairFences(tokens: FenceToken[]): FenceToken[]` は純粋関数。入力をミューテートせず、新しい配列を返す。

- 各シンボル種（`backtick`, `tilde`）ごとに独立に処理。
- infostringあり → 強制的に `kind: "open"` としてスタックにプッシュ。
- `kind: "open"` が明示的に設定されている → 同様に強制的にopenとして扱う（アクション検証時のシミュレーション用）。
- `kind: "close"` → スタックトップのopenとペアリング（最短マッチ）。スタックが空ならopenに昇格。
- その他（デフォルト） → 同上の最短マッチロジック。
- ペアリング後、スタックに残ったopenは `pairId: 0`（未ペア）のまま。

### 5.3 曖昧なケースの扱い

infostringがなく最短マッチのみで判定できる場合、仕様上は一意に解釈されるが著者の意図とずれる可能性がある。このツールはその「仕様上の解釈」をStatusに表示し、ユーザーが手動で組み替える。

自動変換は行わない。

### 5.4 抽出する情報

各フェンス行から以下を取得する:

| フィールド | 型 | 説明 |
|---|---|---|
| `line` | number | 行番号（1始まり） |
| `raw` | string | 元の行テキスト（80文字でtruncate済み） |
| `backtickCount` | number | バッククォートまたはチルダの個数 |
| `symbol` | `"backtick" \| "tilde"` | フェンス記号の種類 |
| `infostring` | `string \| null` | 言語指定子（あれば）。終了フェンスは常にnull |
| `kind` | `"open" \| "close"` | 開始/終了の別 |
| `pairId` | number | ペアID（1始まり。0は未ペア） |

---

## 6. アクション生成と検証

### 6.1 `generateValidActions(state: EditorState): Action[]`

アクションは現在の `EditorState` から毎回動的に生成される。各アクションはペアリングシミュレーションによって検証され、有効な遷移のみが表示される。

### 6.2 ペアワイズクローズスワップ（主要メカニズム）

2つのペア `(A, B)` 間で `A.close.line < B.open.line` の場合、それらの閉じフェンスを入れ替えるシミュレーションを実行する:

1. `outputTokens` をクローン。
2. `A.close` を `kind: "open"` に昇格、`B.open` を `kind: "close"` に設定。
3. `pairFences()` をクローン上で実行。
4. **有効条件**:
   a. 全トークンの `pairId > 0`（ゼロオーファン）。
   b. 結果のペアリング構造が現在状態と異なる（`openLine-closeLine` のソート済みセットを比較）。

有効な場合、アクションを生成: `Change close fence for O.{A.id} from line {A.close.line} to line {B.close.line} (auto-pairs O.{B.id} to line {B.open.line})`

### 6.3 シングルクローズチェンジ（フォールバック）

未ペアのトークン（`pairId === 0`）に対して、既存ペアの閉じフェンスを移動させるシミュレーション:

1. `outputTokens` をクローン。
2. 旧閉じを `kind: "open"` に昇格、候補を `kind: "close"` に設定。
3. `pairFences()` を実行。
4. 有効条件はスワップと同様（ゼロオーファン + 構造変化）。

### 6.4 バッククォート自動調整

アクション適用後、ネスト関係にあるペアを検出し、外側フェンスの `backtickCount` が内側の `backtickCount + 1` 以上になるよう最小限の増加を行う。

**判定ルール:**
- `inner.open.line > outer.open.line` かつ `inner.close.line < outer.close.line` でネストと判定。
- 両方とも `symbol: "backtick"` の場合のみ調整対象。
- 外側の両トークン（open/close）に同じ増分を適用。
- 調整後、`raw` 文字列を再生成。

### 6.5 No-Op フィルター

シミュレーション結果が現在のペアリング構造と同一の場合、そのアクションは生成されない。

---

## 7. 状態ミューテーションとアクション適用

### 7.1 `applyAction(state: EditorState, actionIndex: number): EditorState`

アクション番号を受け取り、対応する操作を `outputTokens` に適用する:

- **restructure**: クローズチェンジまたはスワップを実行。`kind`, `pairId` を更新 → `pairFences()` 再実行 → `autoAdjustBackticks()` → `raw` 再生成 → `actionLog` に記録を追加。
- **increase-backtick**: 対象ペアの全トークンの `backtickCount` を必要最小値に更新 → `raw` 再生成 → `actionLog` に記録。
- **convert-tilde**: 全 `tilde` トークンを `backtick` に変換 → `raw` 再生成 → `hasTilde: false` → `actionLog` に記録。

### 7.2 出力ファイルの再構築

`reconstructOutput(outputTokens: FenceToken[], originalLines: string[]): string`:

1. `outputTokens` を行番号でマップ化。
2. `originalLines` を順に走査。行番号がトークンに一致する場合、その行を `token.raw` で置換。
3. 一致しない行は原文のまま保持。
4. 結果を `\n` で結合。

**保証:** フェンス行以外のすべての行は一字一句変更されない。

---

## 8. 出力ファイルの仕様

### 8.1 通常出力

入力ファイルのテキストに対してフェンスのバッククォート数変更・記号変換のみを施した結果を出力する。フェンス行以外の行は一切変更しない。

### 8.2 Statusログの保存（優先度: 低）

対話UI終了時に `Status` テーブルをマークダウンまたはDjotのファイルとして保存するオプション。

セル内のバッククォートはHTMLエンティティとして書き出す（例: `&#96;&#96;&#96;js`）。

---

## 9. 動作環境

| 項目 | 要件 |
|---|---|
| ランタイム | Deno 2.x 以上 |
| 外部依存 | `micromark@^3.0.0`（CommonMark）、`@djot/djot@^0.3.0`（Djot） |
| パーミッション | `--allow-read`（必須）、`--allow-write`（出力先 `[1]`/`[2]` のみ） |
| ターミナル | ANSIエスケープシーケンス対応のターミナル |
| 言語 | Strict TypeScript（`any` 禁止、完全な型推論） |

---

## 10. 実装しないもの

- マークダウン → Djot の全文変換
- コードフェンス行の前後行の表示
- TUIフレームワークの使用
- 矢印キーによるナビゲーション（連番入力方式のみ）
- `--force-backtick` CLIオプション（UI内のActionに統合）
- `--dry-run` / `--diff` オプション（対話UIがその役割を果たす）
- `--check` オプション（修正要否の自動判定は設計上不可能なため）
