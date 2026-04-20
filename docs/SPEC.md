# SPEC.md — fence-editor 実装要件定義書

## 1. プロジェクト概要

**ツール名:** `fence-editor`
**目的:** マークダウンおよびDjot文書に含まれるコードフェンスのペア構造を可視化し、ユーザーが対話的に組み替えられるCLIツール。
**主なユースケース:** AIチャットのログなど、複数ソースからマージされたマークダウン文書において、コードフェンスのネスト構造が意図通りになっていない場合の修正。

---

## 2. 対応フォーマット

| フォーマット | パーサー | 拡張子 |
|---|---|---|
| CommonMark | micromark | `.md`, `.markdown`, `.mdx` |
| Djot | djot.js | `.dj`, `.djt` |

### 自動検出ルール

`--format` フラグが省略された場合、入力ファイルの拡張子からパーサーを自動検出する:

- `.md`, `.markdown`, `.mdx` → `commonmark`
- `.dj`, `.djt` → `djot`
- 不明な拡張子、拡張子なし、または stdin → `commonmark` にフォールバック

### 明示的オーバーライド

`--format <commonmark|djot>` が指定された場合、自動検出を完全に上書きする。

例: `fence-editor doc.md --format djot` → Djotパーサーを使用。

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
  --format <commonmark|djot>  Set parser format (default: auto-detect from extension)
  --version                   Show version information
  -h, --help                  Show this help

Auto-Detection:
  .md, .markdown, .mdx → CommonMark
  .dj, .djt             → Djot
  Unknown extension or stdin → CommonMark

Interactive Mode:
  Enter a number from Actions to apply changes to the fence structure.
  Press 0 to exit, choose an output destination, and save changes.
  Press Ctrl+C to abort immediately without saving any changes.
  Output destinations: [1] Save as new file, [2] Overwrite input, [3] Print to stdout

Examples:
  fence-editor input.md              # auto-detects CommonMark
  fence-editor notes.dj              # auto-detects Djot
  fence-editor input.md --format djot  # override to Djot
  cat input.dj | fence-editor          # stdin, falls back to CommonMark
```

### オプション一覧

| オプション | 説明 |
|---|---|
| `--format <commonmark\|djot>` | パーサーの指定（省略時は拡張子から自動検出、不明な場合は commonmark） |
| `--version` | バージョン表示 |
| `-h, --help` | ヘルプ表示 |

### ストリーム分離

**stdout** は再構築されたドキュメントデータのみを出力する（Unixパイプライン安全）。ANSIエスケープコード、プロンプト、UIテキストは一切含まれない。

**stderr** はすべての対話UI（Terms、Statusテーブル、Actions、プロンプト、エラーメッセージ、Goodbye）を出力する。

これにより、以下のパイプラインワークフローが動作する:

```sh
fence-editor input.md | grep "code"        # stdoutにはドキュメントのみ
fence-editor input.md | pandoc -f markdown # stdoutを別ツールに渡す
```

### 入力ファイル未指定時の挙動

入力ファイルが指定されずstdinも空の場合、エラーメッセージを stderr に出力して終了コード1で終了する。

### 出力先の選択

対話UIで `0` を入力すると終了フローに入り、以下の出力先選択プロンプトが stderr に表示される:

```
Choose output destination for edited file:

  [1] Save as new file
  [2] Overwrite input file
  [3] Print to stdout

Also save a summary of fence edits:

  [4] Save status table as Markdown file

> Enter action # | 0 to return to editor | Ctrl+C to cancel
```

- `[1] Save as new file`: 新規ファイルパスの入力を求める。デフォルトは `${base}_edited.<ext>`（拡張子は解決済みパーサーに対応）。stdin入力のデフォルトは `edited_output.<ext>`。ユーザーは任意のパスを入力可能。
- `[2] Overwrite input file`: 入力ファイルを上書き。stdinからの入力だった場合はエラーで終了。
- `[3] Print to stdout`: 再構築後のドキュメントを stdout にのみ出力。UIテキストは一切含まない。
- `[4] Save status table as Markdown file`: 編集ログをMarkdownファイルとして保存。
- `[0] Cancel`: 保存せずにエディターに戻る。対話ループが再開され、さらにアクションを適用できる。

`[1]` を選択した場合、ファイルパスの入力プロンプトが表示される（デフォルト値付き）:

```sh
Enter file path [{base}_edited.{md|dj}]:
```

`[4]` を選択した場合、ファイルパスの入力プロンプトが表示される（デフォルト値付き）:

- 入力がファイルの場合: `Enter file path [{base}.edits.{md|dj}]:`
- 入力がstdinの場合: `Enter file path [edited_output.edits.{md|dj}]:`

ファイル拡張子（`.md` または `.dj`）は入力フォーマットに基づいて自動的に決定される。

### デフォルトファイル名生成ルール

`[1] Save as new file` 選択時:

| 入力パス | 解決フォーマット | デフォルト出力パス |
|---|---|---|
| `doc.md` | commonmark | `doc_edited.md` |
| `test/00.dj` | djot | `test/00_edited.dj` |
| `notes.md`（`--format djot`で上書き） | djot | `notes_edited.dj` |
| `Makefile`（拡張子なし） | commonmark | `Makefile_edited.md` |
| stdin | commonmark | `edited_output.md` |
| stdin | djot（`--format djot`） | `edited_output.dj` |

`[4] Save status table as Markdown file` 選択時:

| 入力パス | 解決フォーマット | デフォルトログパス |
|---|---|---|
| `doc.md` | commonmark | `doc.edits.md` |
| `test/00.dj` | djot | `test/00.edits.dj` |
| stdin | commonmark | `edited_output.edits.md` |
| stdin | djot（`--format djot`） | `edited_output.edits.dj` |

---

## 4. 対話UIの仕様

### 4.1 起動後の表示構成

UIは以下の順序で stderr に描画される:

```
Terms:

  I. = fence pair id (input)
  O. = fence pair id (output)

Parsed as CommonMark

Status:
| line | input                | I. | O. | output               |
|-----:|:---------------------|---:|---:|:---------------------|
|    5 | ```                  |  1 |  2 | ````                 |
|    8 | ```                  |  1 |  1 | ```                  |
|   11 | ```                  |  2 |  1 | ```                  |
|   14 | ```                  |  2 |  2 | ````                 |

  O.1: line 8 → line 11 (backtick, 3x)
  O.2: line 5 → line 14 (backtick, 4x)

Actions:

  [1] Change close fence for O.1 from line 8 to line 14 (auto-pairs O.2 to line 11)

> Enter action # | 0 to exit & save | Ctrl+C to cancel
```

描画順序:
1. `Terms:` ブロック
2. `Parsed as <FORMAT>` 行（左揃え。`CommonMark` または `Djot`）
3. `Status:` テーブル
4. ペアサマリー（`O.{id}: line {open} → line {close} ({symbol}, {count}x)`）
5. `Actions:` ヘッダー
6. アクションリスト
7. フッターヒント行（必須）

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
- `0` + Enter で終了フローへ移行（出力先選択）。
- `Ctrl+C` は即座に終了コード0でabort。ファイルへの変更は一切保存されない。未処理の例外は発生しない。

### 4.4 必須フッター行

Actionsリストの直下に以下のヒント行を毎回の再描画で必ず表示する:

```
  > Enter action # | 0 to exit & save | Ctrl+C to cancel
```

### 4.5 Actionsの内容

**シミュレーション検証によって生成されるもの:**

- フェンスのペアの組み替え（閉じフェンスの変更） — シングルクローズチェンジまたはペアワイズクローズスワップにより、ゼロオーファンかつ構造変化があり、かつ異種シンボル間の境界交差（cross-symbol crossing）を生まない遷移のみが表示される。

**条件付きで表示されるもの:**

- **チルダフェンスが存在する場合のみ:** `Convert tilde fences to backticks`（全チルダフェンスをバッククォートに変換。変換後、ネストカウントの自動調整をアトミックに実行）。

### 4.6 構造的健全性ルール

**異種シンボル境界交差（cross-symbol crossing）の禁止:**

再構築アクション候補が、異なるシンボル種（backtick↔tilde）のペア間で範囲交差を生む場合、そのアクションは提案されない。交差の定義:

```
(A.open < B.open < A.close < B.close) または
(B.open < A.open < B.close < A.close)
```

ただし A と B は異なる `symbol` を持つペア。

このルールにより、バックティックフェンスの範囲内にチルダフェンスの一部が含まれ、残りが範囲外に出るような、曖昧で読みにくい構造が生成されることはない。

**チルダ変換後の再構築サプレス:**

`Convert tilde fences to backticks` を適用した直後のフレームでは、再構築アクション（restructure）は一時的に非表示になる。これにより、以前は独立したシンボル種だったブロックが、変換直後に意図せずマージされる提案が表示されるのを防ぐ。ユーザーが別の操作（終了など）を挟んだ後、再び再構築オプションが有効になる。

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
| `backtickCount` | number | バッククォートまたはチルダの個数（汎用のフェンス長フィールド） |
| `symbol` | `"backtick" \| "tilde"` | フェンス記号の種類 |
| `infostring` | `string \| null` | 言語指定子（あれば）。終了フェンスは常にnull |
| `kind` | `"open" \| "close"` | 開始/終了の別 |
| `pairId` | number | ペアID（1始まり。0は未ペア） |

---

## 6. アクション生成と検証

### 6.1 `generateValidActions(state: EditorState): Action[]`

アクションは現在の `EditorState` から毎回動的に生成される。各アクションはペアリングシミュレーションによって検証され、有効な遷移のみが表示される。

利用可能なアクション型は `"restructure"` と `"convert-tilde"` の2種類のみ。スタンドアロンの `increase-backtick` アクションは存在しない。

### 6.2 ペアワイズクローズスワップ（主要メカニズム）

2つのペア `(A, B)` 間で `A.close.line < B.open.line` の場合、それらの閉じフェンスを入れ替えるシミュレーションを実行する:

1. `outputTokens` をクローン。
2. `A.close` を `kind: "open"` に昇格、`B.open` を `kind: "close"` に設定。
3. `pairFences()` をクローン上で実行。
4. **有効条件**:
   a. 全トークンの `pairId > 0`（ゼロオーファン）。
   b. 異種シンボル間の境界交差がない（`hasCrossSymbolCrossing` が `false`）。
   c. 結果のペアリング構造が現在状態と異なる（`openLine-closeLine` のソート済みセットを比較）。

有効な場合、アクションを生成: `Change close fence for O.{A.id} from line {A.close.line} to line {B.close.line} (auto-pairs O.{B.id} to line {B.open.line})`

このメカニズムにより、2つの隣接非ネストペアを有効なネスト構造へ変換できる。

### 6.3 シングルクローズチェンジ（フォールバック）

未ペアのトークン（`pairId === 0`）に対して、既存ペアの閉じフェンスを移動させるシミュレーション:

1. `outputTokens` をクローン。
2. 旧閉じを `kind: "open"` に昇格、候補を `kind: "close"` に設定。
3. `pairFences()` を実行。
4. 有効条件はスワップと同様（ゼロオーファン + 境界交差なし + 構造変化）。

### 6.4 フェンス数自動調整

アクション適用後、ネスト関係にあるペアを検出し、外側フェンスの `backtickCount` が内側の `backtickCount + 1` 以上になるよう最小限の増加を行う。

**判定ルール:**
- `inner.open.line > outer.open.line` かつ `inner.close.line < outer.close.line` でネストと判定。
- **同一シンボル種間のみ**調整対象（backtick↔backtick、tilde↔tilde）。シンボル種を跨いで調整しない。
- 外側の両トークン（open/close）に同じ増分を適用。
- 調整後、全トークンの `raw` 文字列を `rebuildRaw()` で再生成。

### 6.5 アトミックなチルダ変換

`Convert tilde fences to backticks` は以下の手順をアトミックに実行する:

1. 全 `tilde` トークンの `symbol` を `backtick` に変更。
2. `raw` 文字列を再生成。
3. `autoAdjustBackticks()` を実行し、新規変換されたバックティックを含むすべてのネスト違反を解消。
4. `raw` 文字列を再度再生成。
5. `skipRestructure: true` を設定し、次のフレームで再構築アクションを抑制。

これにより、変換後の状態は常に有効なネストカウントを持ち、手動の増分ステップは不要。

### 6.6 No-Op フィルター

シミュレーション結果が現在のペアリング構造と同一の場合、そのアクションは生成されない。

---

## 7. 状態ミューテーションとアクション適用

### 7.1 `applyAction(state: EditorState, actionIndex: number): EditorState`

アクション番号を受け取り、対応する操作を `outputTokens` に適用する:

- **restructure**: クローズチェンジまたはスワップを実行。`kind`, `pairId` を更新 → `pairFences()` 再実行 → `autoAdjustBackticks()` → `raw` 再生成 → `actionLog` に記録を追加 → `skipRestructure: false`。
- **convert-tilde**: 全 `tilde` トークンを `backtick` に変換 → `raw` 再生成 → `autoAdjustBackticks()` でネスト調整 → `hasTilde: false` → `skipRestructure: true` → `actionLog` に記録。

スワップアクションの場合、両ペアの4トークン（A.open, A.close, B.open, B.close）を一度に変更し、`pairFences()` に委譲して最終的なペアIDを決定する。

### 7.2 `skipRestructure` フラグ

`EditorState.skipRestructure: boolean` は、チルダ変換の直後に再構築アクションを1フレームだけ抑制するための状態フラグ。

- `convert-tilde` 適用後 → `true` に設定。
- `restructure` 適用後 → `false` にリセット。
- `true` の間、`generateValidActions` は `restructure` 型のアクションを生成しない（`convert-tilde` は通常通り）。

### 7.3 出力ファイルの再構築

`reconstructOutput(outputTokens: FenceToken[], originalLines: string[]): string`:

1. `outputTokens` を行番号でマップ化。
2. `originalLines` を順に走査。行番号がトークンに一致する場合、その行を `token.raw` で置換。
3. 一致しない行は原文のまま保持。
4. 結果を `\n` で結合。

**保証:** フェンス行以外のすべての行は一字一句変更されない。

### 7.4 `rebuildRaw(token: FenceToken): string`

トークンのプロパティから `raw` 文字列を再生成:

- `symbol === "backtick"` → `` ` `` を `backtickCount` 回繰り返す。
- `symbol === "tilde"` → `~` を `backtickCount` 回繰り返す。
- `kind === "open"` かつ `infostring !== null` の場合、フェンス文字の直後に infostring を連結。
- 閉じフェンスの場合はフェンス文字列のみ。

---

## 8. 出力ファイルの仕様

### 8.1 通常出力

入力ファイルのテキストに対してフェンスのバッククォート数変更・記号変換のみを施した結果を出力する。フェンス行以外の行は一切変更しない。

### 8.2 stdoutパイプ互換性

`[3] Print to stdout` は再構築されたマークダウン/Djotドキュメントを `stdout` にのみ出力する。ANSIエスケープコード、プロンプト、UIテキストは一切含まれない。これにより `grep`、`pandoc` 等のUnixパイプラインツールと完全に互換性がある。

### 8.3 Statusログの保存

編集ログは、保存メニューの `[4]` オプションにより `{base}.edits.{md|dj}` として保存される。

ファイル形式は2つのセクションを含む:

- `## Applied Actions`: 実行されたアクションラベルを順序通りに記載（番号付き。TUIで使用される `[N]` プレフィックスはなし）。
- `## Status Changes`: 初期ステータステーブルに続き、各アクションラベルの前に `Done:` を付け、そのアクション適用後のテーブルを表示。

テーブルセル内のバッククォート文字はそのまま書き出される。コードフェンスは行頭にバックティックシーケンスが必要であり、それはテーブルセル内では発生しないため、これは安全である。

---

## 9. 動作環境

| 項目 | 要件 |
|---|---|
| ランタイム | Deno 2.x 以上 |
| 外部依存 | `micromark@^3.0.0`（CommonMark）、`@djot/djot@^0.3.0`（Djot） |
| パーミッション | `--allow-read`（必須）、`--allow-write`（出力先 `[1]`/`[2]` のみ） |
| ターミナル | ANSIエスケープシーケンス対応のターミナル |
| 言語 | Strict TypeScript（`any` 禁止、完全な型推論） |

